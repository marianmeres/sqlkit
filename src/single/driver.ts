/**
 * The single-connection driver core: a `Driver` over one connection, whatever the
 * database. node:sqlite, one `pg.Client`, PGlite and a Durable Object are backends under it
 * (`backend.ts`); this file owns everything that is not the database.
 *
 * **Everything takes its turn on the one connection.** A statement runs at once only from
 * inside the open transaction's own context (its callback and whatever the callback
 * awaits). From anywhere else it queues behind that transaction, as a top-level
 * `transaction()` does: on a shared connection it would otherwise run *inside* another
 * caller's transaction, see its uncommitted rows, and be rolled back with it. The context
 * is carried by `AsyncLocalStorage`, and it stops counting the moment the callback
 * settles, so a promise that outlives its transaction writes outside it rather than into
 * whichever transaction is open next.
 *
 * The rule's one cost: code that runs during a transaction's callback but issues its
 * statement from a context that does not carry the transaction (a callback handed to an
 * emitter, or to a queue created outside it) waits for the transaction it is part of, and
 * that transaction waits for it. The `tx` handle does not help, since it is this driver:
 * the context decides. The context follows `await`; such a callback is bound from inside
 * the transaction (`AsyncLocalStorage.bind`).
 *
 * A nested `transaction()` joins the open one, as it was opened. The backend is asked for
 * a transaction only at the top level, in the connection's turn.
 *
 * **A transaction Postgres aborted is not committed.** On the `pg` dialect a failed
 * statement aborts the whole transaction: every statement after it fails, and the `COMMIT`
 * is answered with `ROLLBACK`, without an error. A callback that caught the failure and
 * resolved anyway would be reported committed with nothing kept, so the core keeps count:
 * once the callback resolved, and whatever it issued in the transaction and did not await
 * has settled, a transaction whose last failure no later statement got past rejects with
 * `TransactionAbortedError` (the failure is its `cause`), and the backend rolls back
 * instead of committing. A statement that succeeds after a failure means the transaction
 * was recovered (a `rollback to savepoint` is the one that can), so it clears the count.
 * It is the one piece of dialect knowledge the core has: SQLite undoes the failed
 * statement alone, and commits the rest.
 *
 * `exclusive()` is an in-process queue per lock name and, where the backend has a lock
 * other processes honour (`backend.lock`), that lock too, taken once the queue lets a
 * caller through. Called inside an open transaction it does not queue: the transaction
 * already excludes every other caller on the connection, and waiting there for a holder
 * whose statements queue behind the transaction would wait for itself. The backend's lock
 * is then taken on the transaction's connection.
 *
 * `query()` and `exec()` always answer with a promise: a refused call and a failing
 * statement reject, as on any other adapter, even when the engine underneath is
 * synchronous.
 *
 * **Errors are typed here, at the boundary (D07).** Whatever the backend throws, on either
 * tier, from a statement, a script, the opening or the end of a transaction, a lock or
 * `close`, comes out as a `SqlError` of the kind the backend's classifier reads, with the
 * backend's error as `cause`. Two things come out as they were thrown: what a transaction's
 * or a section's callback threw, which is the caller's own, and a `TypeError`, which is a
 * programming mistake and never a `SqlError` (D17).
 *
 * **The sync tier.** Given a `SyncBackend` too, the driver has `sync`: the same connection,
 * answering at once, with a transaction whose callback is synchronous. The two tiers share
 * the connection, so each refuses what would land in the wrong transaction (D16):
 *
 * - **S1** A `sync.transaction` callback that returns a thenable is a `TypeError`, and its
 *   transaction is rolled back: an async callback returns at its first `await`, before
 *   the rest of it has run.
 * - **S2** A nested `sync.transaction` joins the open one, as it was opened.
 * - **S3** A sync call from inside an open async transaction's own context runs inside
 *   that transaction; a `sync.transaction` there joins it.
 * - **S4** A sync call while an async transaction is open, from any other context, is a
 *   `TypeError`: it could only run inside a transaction it does not belong to. "Open"
 *   lasts until the backend has committed or rolled back, so a promise that outlived the
 *   callback is refused too.
 * - **S5** An async call (`query`, `exec`, `transaction`, `exclusive`, `close`) from inside
 *   a sync transaction's callback rejects with a `TypeError`: it could only run after
 *   the callback returned, outside the transaction.
 * - **S6** A sync call while async statements are queued, but no transaction is open,
 *   runs at once, ahead of them.
 *
 * A sync transaction's callback runs to its end before anything else can, so "inside" one
 * is a counter, not a context: whatever runs while the counter is up runs within the
 * callback.
 *
 * Imports `node:async_hooks` and the core, nothing else.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	assertLockName,
	type Capabilities,
	type Driver,
	type QueryResult,
	type Row,
	readOnlyOf,
	type SyncDriver,
	statementOf,
	type TransactionOptions,
} from "../core/contract.ts";
import { TransactionAbortedError, toSqlError } from "../core/errors.ts";
import { normalizeParams } from "../core/params.ts";
import type { Sql } from "../core/sql.ts";
import type {
	Connection,
	MaybePromise,
	SingleConnectionBackend,
	SyncBackend,
} from "./backend.ts";

/**
 * The transaction a context belongs to. One object per transaction, shared by every
 * context that carries it, so closing it once closes it for all of them.
 */
interface OpenTransaction {
	open: boolean;
	/** What the backend handed the transaction's callback: its statements go there. */
	readonly connection: Connection;
	/**
	 * `pg` only: the failure that aborted the transaction, while no statement since has
	 * succeeded.
	 */
	failure: Thrown | undefined;
	/** `pg` only: what the transaction's context sent on its connection, until it settles. */
	readonly pending: Set<Promise<unknown>>;
}

/**
 * One `exclusive` lock held by a context: its name, whether it is still held, and the
 * lock the context already held when it took this one.
 */
interface Holding {
	readonly name: string;
	open: boolean;
	readonly parent: Holding | undefined;
}

/** What a callback threw, boxed, so that even a thrown `undefined` is told from none. */
interface Thrown {
	readonly error: unknown;
}

const settled = (): undefined => undefined;

/**
 * A `Driver` over one connection. `close()` ends the connection the backend was given.
 * With `syncBackend`, the same connection answering at once, the driver has `sync` too.
 */
export function createSingleConnectionDriver(
	backend: SingleConnectionBackend,
	syncBackend?: SyncBackend,
): Driver {
	const dialect = backend.dialect;
	const classify = backend.classify.bind(backend);

	/**
	 * What the backend threw, as the contract has it: a `SqlError` of its kind, with the
	 * backend's error as `cause` (D07). A `TypeError` is a programming mistake and stays one.
	 */
	const wrap = (error: unknown): unknown =>
		error instanceof TypeError ? error : toSqlError(error, dialect, classify);

	/** The one way into the backend: what `call` throws or rejects with is wrapped. */
	const guard = async <T>(call: () => MaybePromise<T>): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			throw wrap(error);
		}
	};

	/** The same, for the sync tier: the backend answers at once, or throws. */
	const guardSync = <T>(call: () => T): T => {
		try {
			return call();
		} catch (error) {
			throw wrap(error);
		}
	};

	/**
	 * What a backend's `transaction` threw: the callback's own error as it was thrown,
	 * anything else (a failed `BEGIN` or `COMMIT`) wrapped.
	 */
	const fromTransaction = (error: unknown, thrown: Thrown | undefined): unknown =>
		thrown !== undefined && error === thrown.error ? error : wrap(error);

	/**
	 * Whether a failed statement aborts the whole transaction: Postgres's rule, which the
	 * core tracks (see the header). SQLite undoes the failed statement alone.
	 */
	const abortsOnFailure = dialect === "pg";

	const backendLock = backend.lock?.bind(backend);
	/** The backend's lock, its taking and its release both guarded. */
	const lock =
		backendLock === undefined
			? undefined
			: async (
					name: string,
					inTransaction: boolean,
				): Promise<() => Promise<void>> => {
					const free = await guard(() => backendLock(name, inTransaction));
					return () => guard(free);
				};
	const capabilities: Capabilities = Object.freeze({
		sync: syncBackend !== undefined,
		concurrentWriters: false,
		crossProcessLock: lock !== undefined,
	});

	const current = new AsyncLocalStorage<OpenTransaction>();
	let queue: Promise<unknown> = Promise.resolve();
	/** An async transaction is open on the connection: from its start until it settled. */
	let asyncOpen = false;
	/** How many sync transaction callbacks are running: above 0, the caller is in one. */
	let syncDepth = 0;

	/** S5: an async call from inside a sync transaction's callback, refused. */
	const insideSync = (call: string): TypeError | undefined =>
		syncDepth > 0
			? new TypeError(
					`${call} cannot be called inside a sync transaction: it could only run ` +
						"after the callback returned, outside the transaction. Use the sync " +
						"tier there (tx.query, tx.exec, tx.transaction)",
				)
			: undefined;

	/** Only the open transaction's own context; one whose transaction ended is none. */
	const openTransaction = (): OpenTransaction | undefined => {
		const tx = current.getStore();
		return tx?.open === true ? tx : undefined;
	};

	/** Run `work` after everything queued before it, whatever that answered. */
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const run = queue.then(work, work);
		queue = run.then(settled, settled);
		return run;
	};

	/** `fn(driver)` as a promise: a synchronous throw rejects it. */
	const invoke = <T>(fn: (tx: Driver) => Promise<T>): Promise<T> => {
		try {
			return Promise.resolve(fn(driver));
		} catch (error) {
			return Promise.reject(error);
		}
	};

	const runOn = (
		connection: Connection,
		text: string,
		params: readonly unknown[],
	): Promise<QueryResult<Row>> => guard(() => connection.run(text, params));

	/**
	 * `call`, sent on the open transaction `tx`. On `pg` its outcome is counted: a failure
	 * aborted the transaction, and a statement's success after one recovered it. A lock's
	 * success does not count, since a backend may take or release it without a statement.
	 * A `TypeError` is a refusal, not the database's answer, and counts for neither.
	 */
	const inTransaction = <T>(
		tx: OpenTransaction,
		call: () => Promise<T>,
		statement = true,
	): Promise<T> => {
		if (!abortsOnFailure) return call();
		const answer = call().then(
			(value) => {
				if (statement) tx.failure = undefined;
				return value;
			},
			(error: unknown) => {
				if (!(error instanceof TypeError)) tx.failure ??= { error };
				throw error;
			},
		);
		const done = answer.then(settled, settled);
		tx.pending.add(done);
		void done.then(() => tx.pending.delete(done));
		return answer;
	};

	/**
	 * `pg`: wait for what the transaction's context sent and did not await, then refuse
	 * to commit a transaction a failure aborted. Called once its callback resolved, so
	 * nothing new is added meanwhile: the context is no longer the transaction's.
	 */
	const assertNotAborted = async (tx: OpenTransaction): Promise<void> => {
		if (!abortsOnFailure) return;
		while (tx.pending.size > 0) await Promise.all(tx.pending);
		if (tx.failure === undefined) return;
		throw new TransactionAbortedError(
			"a statement inside the transaction failed, and Postgres aborted the " +
				"transaction with it: it was rolled back, not committed. The callback " +
				"caught that statement's error and returned as if it had succeeded",
			dialect,
			{ kind: "aborted" },
			tx.failure.error,
		);
	};

	const execOn = (connection: Connection, script: string): Promise<void> =>
		guard(() => connection.exec(script));

	/** The text and the bound values of one statement; a `TypeError` when refused. */
	const prepare = (
		statement: Sql | string,
		params: readonly unknown[] | undefined,
	): { text: string; values: unknown[] } => {
		const rendered = statementOf(statement, params, dialect);
		return { text: rendered.text, values: normalizeParams(rendered.params, dialect) };
	};

	const query = <T = Row>(
		statement: Sql | string,
		params?: readonly unknown[],
	): Promise<QueryResult<T>> => {
		let text: string;
		let values: unknown[];
		try {
			({ text, values } = prepare(statement, params));
		} catch (error) {
			return Promise.reject(error);
		}
		const refused = insideSync("query()");
		if (refused !== undefined) return Promise.reject(refused);
		const tx = openTransaction();
		const answer =
			tx === undefined
				? enqueue(() => runOn(backend, text, values))
				: inTransaction(tx, () => runOn(tx.connection, text, values));
		return answer as Promise<QueryResult<T>>;
	};

	const exec = (script: string): Promise<void> => {
		if (typeof script !== "string") {
			return Promise.reject(
				new TypeError(`exec(script) takes SQL text, got ${describe(script)}`),
			);
		}
		const refused = insideSync("exec()");
		if (refused !== undefined) return Promise.reject(refused);
		const tx = openTransaction();
		return tx === undefined
			? enqueue(() => execOn(backend, script))
			: inTransaction(tx, () => execOn(tx.connection, script));
	};

	const transaction = <T>(
		fn: (tx: Driver) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T> => {
		let readOnly: boolean;
		try {
			readOnly = readOnlyOf(options);
			assertCallback(fn, "transaction(fn)");
		} catch (error) {
			return Promise.reject(error);
		}
		const refused = insideSync("transaction()");
		if (refused !== undefined) return Promise.reject(refused);
		// Nested: the open transaction is the transaction, as it was opened.
		if (openTransaction() !== undefined) return invoke(fn);
		return enqueue(async () => {
			// Open for the sync tier until the backend is done, not until `fn` is: between
			// the two the connection is still inside the transaction (S4).
			asyncOpen = true;
			let thrown: Thrown | undefined;
			try {
				return await backend.transaction(async (connection) => {
					const tx: OpenTransaction = {
						open: true,
						connection,
						failure: undefined,
						pending: new Set(),
					};
					let result: T;
					try {
						result = await current.run(tx, () => invoke(fn));
					} catch (error) {
						thrown = { error };
						throw error;
					} finally {
						// Before the backend commits or rolls back: whatever the callback
						// left running is a stranger from here on, and queues like one.
						tx.open = false;
					}
					// Not the callback's error: thrown here, the backend rolls back.
					await assertNotAborted(tx);
					return result;
				}, readOnly);
			} catch (error) {
				throw fromTransaction(error, thrown);
			} finally {
				asyncOpen = false;
			}
		});
	};

	const holding = new AsyncLocalStorage<Holding>();
	/** The tail of each lock name's queue; gone once nobody holds or waits for it. */
	const locks = new Map<string, Promise<unknown>>();

	/** Whether this context already holds the lock `name`. */
	const holds = (name: string): boolean => {
		for (let at = holding.getStore(); at !== undefined; at = at.parent) {
			if (at.open && at.name === name) return true;
		}
		return false;
	};

	/** Run `body` holding `name`, so that a call with that name inside it runs at once. */
	const hold = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
		const lease: Holding = { name, open: true, parent: holding.getStore() };
		try {
			return await holding.run(lease, body);
		} finally {
			// Whatever `body` left running no longer holds it, and queues like a stranger.
			lease.open = false;
		}
	};

	/**
	 * `fn` under the backend's lock, taken and released by `acquire` and through the
	 * release it answers. `fn`'s rejection wins over a failed release.
	 */
	const underLock = async <T>(
		fn: (tx: Driver) => Promise<T>,
		acquire: () => Promise<() => Promise<void>>,
		release: (free: () => Promise<void>) => Promise<void>,
	): Promise<T> => {
		const free = await acquire();
		let result: T;
		try {
			result = await invoke(fn);
		} catch (error) {
			await release(free).catch(settled);
			throw error;
		}
		await release(free);
		return result;
	};

	const exclusive = <T>(name: string, fn: (tx: Driver) => Promise<T>): Promise<T> => {
		try {
			assertLockName(name);
			assertCallback(fn, "exclusive(name, fn)");
		} catch (error) {
			return Promise.reject(error);
		}
		const refused = insideSync("exclusive()");
		if (refused !== undefined) return Promise.reject(refused);
		// Re-entrant.
		if (holds(name)) return invoke(fn);
		// Inside an open transaction the transaction is the lock, on this connection.
		const tx = openTransaction();
		if (tx !== undefined) {
			if (lock === undefined) return invoke(fn);
			return hold(name, () =>
				underLock(
					fn,
					() => inTransaction(tx, () => lock(name, true), false),
					(free) => inTransaction(tx, free, false),
				),
			);
		}
		const work = (): Promise<T> =>
			hold(name, () =>
				lock === undefined
					? invoke(fn)
					: underLock(
							fn,
							() => enqueue(() => lock(name, false)),
							(free) => enqueue(free),
						),
			);
		const run = (locks.get(name) ?? Promise.resolve()).then(work);
		const tail = run.then(settled, settled);
		locks.set(name, tail);
		void tail.then(() => {
			if (locks.get(name) === tail) locks.delete(name);
		});
		return run;
	};

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		const refused = insideSync("close()");
		if (refused !== undefined) return Promise.reject(refused);
		if (openTransaction() !== undefined) {
			// It would queue behind the transaction, which waits for it.
			return Promise.reject(
				new TypeError("close() cannot be called inside a transaction"),
			);
		}
		closing = enqueue(() => guard(() => backend.close()));
		return closing;
	};

	/**
	 * Whether a sync call may run now, on the connection as it is. Inside a sync
	 * transaction it is that transaction (S2); inside an open async transaction's own
	 * context it joins that one (S3); with no transaction open it runs at once, ahead of
	 * whatever is queued (S6). Anywhere else an async transaction is open, and the call
	 * is refused (S4).
	 */
	const assertSyncTurn = (call: string): void => {
		if (syncDepth > 0 || !asyncOpen || openTransaction() !== undefined) return;
		throw new TypeError(
			`sync.${call} cannot run while an async transaction is open, from outside its ` +
				"callback: it could only run inside a transaction it does not belong to. " +
				"Await the transaction first, or issue the call from inside its callback",
		);
	};

	/** The sync tier over `engine`: the same connection, answering at once. */
	const syncTier = (engine: SyncBackend): SyncDriver => {
		/** A sync transaction's callback, counted while it runs; a thenable it answers is S1. */
		const run = <T>(fn: (tx: SyncDriver) => T): T => {
			syncDepth++;
			let result: T;
			try {
				result = fn(tier);
			} finally {
				syncDepth--;
			}
			if (isThenable(result)) {
				// Its outcome went with the rolled-back transaction; the TypeError says why.
				if (result instanceof Promise)
					Promise.prototype.then.call(result, settled, settled);
				throw new TypeError(
					"sync.transaction(fn): fn returned a promise, so the transaction was " +
						"rolled back. A sync transaction's callback cannot be async: it returns " +
						"at its first await. Use transaction() for one that awaits",
				);
			}
			return result;
		};

		const tier: SyncDriver = {
			dialect,
			adapter: backend.adapter,
			capabilities,
			query<T = Row>(
				statement: Sql | string,
				params?: readonly unknown[],
			): QueryResult<T> {
				const { text, values } = prepare(statement, params);
				assertSyncTurn("query()");
				return guardSync(() => engine.run(text, values)) as QueryResult<T>;
			},
			exec(script: string): void {
				if (typeof script !== "string") {
					throw new TypeError(
						`sync.exec(script) takes SQL text, got ${describe(script)}`,
					);
				}
				assertSyncTurn("exec()");
				guardSync(() => engine.exec(script));
			},
			transaction<T>(fn: (tx: SyncDriver) => T, options?: TransactionOptions): T {
				const readOnly = readOnlyOf(options);
				assertCallback(fn, "sync.transaction(fn)");
				assertSyncTurn("transaction()");
				// Nested (S2), or inside an async transaction's own context (S3): the open
				// transaction is the transaction, as it was opened.
				if (syncDepth > 0 || openTransaction() !== undefined) return run(fn);
				let thrown: Thrown | undefined;
				try {
					return engine.transaction(() => {
						try {
							return run(fn);
						} catch (error) {
							thrown = { error };
							throw error;
						}
					}, readOnly);
				} catch (error) {
					throw fromTransaction(error, thrown);
				}
			},
		};
		return tier;
	};

	const sync = syncBackend === undefined ? undefined : syncTier(syncBackend);
	// One object: the `tx` every callback receives is this driver, `sync` included.
	const driver: Driver = {
		dialect,
		adapter: backend.adapter,
		capabilities,
		query,
		exec,
		transaction,
		exclusive,
		close,
		...(sync === undefined ? {} : { sync }),
	};
	return driver;
}

/** Whatever `await` would wait for: an object or function with a `then` method. */
function isThenable(value: unknown): boolean {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/** A callback, refused before anything starts when it is not a function. */
function assertCallback(fn: unknown, call: string): void {
	if (typeof fn !== "function") {
		throw new TypeError(`${call} takes a function, got ${describe(fn)}`);
	}
}

/** A short, safe description of a value for an error message. */
function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
