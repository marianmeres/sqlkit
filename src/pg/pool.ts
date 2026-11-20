/**
 * The Postgres driver over a pool: a `Driver` over a node-postgres `pg.Pool`, or anything
 * shaped like one (`types.ts`).
 *
 * The driver takes a pool the host built and owns its lifetime from then on (`close()`
 * ends it). It imports nothing from `pg`, not even its types, so the host decides how the
 * pool is configured.
 *
 * `transaction()` is the only place a connection is pinned: it checks out one client,
 * runs `BEGIN`/`COMMIT`/`ROLLBACK` on it, and carries it through `AsyncLocalStorage` so
 * that a `query()` anywhere inside the callback, on the `tx` handle or on the original
 * driver object, lands on that same client. A nested call joins the open transaction. A
 * `BEGIN` sent through a pool is not a transaction: each statement may take a different
 * connection.
 *
 * A transaction's context stops counting the moment its callback settles, before `COMMIT`
 * or `ROLLBACK` is sent. A promise that outlives its transaction then takes a connection
 * of its own like any other caller, rather than writing on a client that has gone back to
 * the pool and may already be pinned by somebody else's transaction.
 *
 * `savepoint()` inside a transaction is `SAVEPOINT` on the pinned client, then `RELEASE`,
 * or `ROLLBACK TO` when its callback rejected. Its callback runs in a context of its own:
 * a statement runs inside the savepoint only when that callback issued it, and whatever
 * the enclosing transaction issues meanwhile, another savepoint included, waits on the
 * client for the savepoint to end. A transaction, and a savepoint, ends only once the
 * savepoints opened in it have: one that was not awaited would otherwise run on after
 * the `COMMIT`. A `RELEASE` Postgres refuses because a statement inside failed and the
 * callback swallowed the error is turned into a `ROLLBACK TO`, which recovers the
 * transaction, and a `TransactionAbortedError`. Outside a transaction `savepoint()` is
 * `transaction()`.
 *
 * `exclusive()` pins a connection too, for a different reason: it holds a **session
 * advisory lock** keyed by the lock name and `current_schema()` (two schemas are two
 * deployments, and the test suite runs a schema per case), and every statement its
 * callback issues runs on that connection, so a pool of one cannot deadlock against it,
 * and `CREATE INDEX CONCURRENTLY` runs outside a transaction. A transaction opened inside
 * it runs on the same connection, and a statement issued from the section's own context
 * waits for that transaction rather than running inside it. Inside an open transaction it
 * takes the transaction-scoped lock on the pinned client.
 *
 * The lock is **polled** (`pg_try_advisory_lock`), never waited for in a statement:
 * `lock.ts`, shared with the client driver, says why.
 *
 * `transaction(fn, { readOnly: true })` begins `REPEATABLE READ READ ONLY`: one snapshot,
 * taken at its first statement, for all of them: what a dump reads its pages in.
 *
 * `COMMIT` is checked, not trusted: Postgres answers the `COMMIT` of a transaction a failed
 * statement aborted with `ROLLBACK`, and no error. A callback that caught that statement's
 * error and returned normally would otherwise be reported as committed; it rejects with
 * `TransactionAbortedError` instead. A `ROLLBACK` that failed leaves the connection in a
 * state nobody knows, so it is destroyed, not handed back to the pool.
 *
 * **Errors are typed at the boundary (D07).** Every call into node-postgres goes through one
 * guard (`guard`): checking a connection out, every statement (the caller's, `BEGIN`,
 * `COMMIT`, the lock polls, `set search_path`) and ending the pool. What it throws comes out
 * as a `SqlError` of the kind `classifyPg` reads, with node-postgres's error as `cause`.
 * What a callback threw comes out as it was thrown, and a `TypeError` stays one: a
 * programming mistake is never a `SqlError` (D17).
 *
 * The pool's `error` event (an idle client the server dropped) is listened to, because a
 * pool nobody listens to ends the process on the first one. When the host listens too,
 * the driver stays quiet; when it is the only listener it reports the error through
 * `process.emitWarning`.
 *
 * `exec()` sends its script as one simple query, with no parameters, so it may hold any
 * number of statements. `query()` sends its text on the extended protocol, parameters or
 * not, so a text of several statements is refused by the server before any of it runs.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { classifyPg } from "../core/classify-pg.ts";
import {
	assertLockName,
	type Capabilities,
	type Driver,
	type QueryResult,
	type Row,
	readOnlyOf,
	statementOf,
	type TransactionOptions,
} from "../core/contract.ts";
import { TransactionAbortedError, toSqlError } from "../core/errors.ts";
import { normalizeParams } from "../core/params.ts";
import { savepointBy, savepointName } from "../core/savepoint.ts";
import type { Sql } from "../core/sql.ts";
import { type LockKey, type LockStatement, lockKeyOf, takeLock, unlock } from "./lock.ts";
import {
	BEGIN_READ_ONLY,
	describe,
	notCommitted,
	notKept,
	resultOf,
	searchPathOf,
} from "./session.ts";
import type {
	PgClientLike,
	PgDriverOptions,
	PgPoolClientLike,
	PgPoolLike,
	PgQueryResultLike,
} from "./types.ts";

/**
 * A pinned client and what it is pinned for: a transaction, a savepoint inside one, or an
 * `exclusive` section holding a session advisory lock. One object per pin, shared by
 * every context that carries it, so closing it once closes it for all of them.
 */
interface Pin {
	readonly client: PgPoolClientLike;
	readonly kind: "transaction" | "savepoint" | "exclusive";
	open: boolean;
	/**
	 * The section a transaction was opened inside, whose client it runs on; the
	 * transaction or the savepoint a savepoint was opened in.
	 */
	readonly parent: Pin | undefined;
	/** The lock names held on this pin: until the section ends, or the transaction does. */
	readonly held: Set<string>;
	/**
	 * What takes turns on the pin's client. In a section: its own statements and
	 * transactions. In a transaction or a savepoint: a savepoint opened in it, and what
	 * was issued there after.
	 */
	turn: Promise<unknown>;
	/** How many of those have not settled. */
	waiting: number;
	/** How many savepoints deep: 0 for a transaction and for a section. */
	readonly depth: number;
}

/** Whether a pin is a transaction or a savepoint of one: its client is inside a transaction. */
function inTransaction(pin: Pin | undefined): boolean {
	return pin !== undefined && pin.kind !== "exclusive";
}

const settled = (): undefined => undefined;

/**
 * What node-postgres threw, as the contract has it: a `SqlError` of its kind, with the
 * driver's error as `cause` (D07). A `TypeError` is a programming mistake and stays one.
 */
function wrap(error: unknown): unknown {
	return error instanceof TypeError ? error : toSqlError(error, "pg", classifyPg);
}

/** The one way into node-postgres: what `call` throws or rejects with is wrapped. */
async function guard<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw wrap(error);
	}
}

/**
 * Text on `client`, guarded. Without `values` node-postgres sends it as a simple query,
 * which runs every statement it holds: what `exec()` and the adapter's own statements
 * want. With `values`, even none, it goes as one statement on the extended protocol, and
 * the server refuses a text of several before running any of it: what `query()` wants.
 */
function send(
	client: PgClientLike,
	text: string,
	values?: unknown[],
): Promise<PgQueryResultLike> {
	return guard(() =>
		values === undefined
			? client.query({ text })
			: client.query({ text, values, queryMode: "extended" }),
	);
}

/**
 * A driver over a pool the host built. `close()` ends the pool; a host that keeps its pool
 * does not call it.
 *
 * With `options.schema`, every connection the driver checks out has its `search_path`
 * set to that one schema first. A pooled client's `search_path` only has to be set once
 * per physical connection, and `pool.connect()` hands back the same client object for the
 * same connection, so a `WeakSet` turns "per checkout" into "per connection" without a
 * correctness risk: a miss costs one extra round trip, never a wrong `search_path`.
 */
export function createPgDriver(pool: PgPoolLike, options?: PgDriverOptions): Driver {
	assertPool(pool);
	const setSearchPath = searchPathOf(options, "createPgDriver", "pool");

	// An idle client's error is emitted on the pool, and an `error` nobody listens to
	// ends the process. Quiet when the host listens as well: the report is theirs.
	pool.on("error", (error: Error) => {
		if (pool.listenerCount("error") > 1) return;
		process.emitWarning(
			new Error(
				`postgres: an idle pooled connection failed and was discarded: ${error.message}`,
				{ cause: error },
			),
		);
	});

	const capabilities: Capabilities = Object.freeze({
		sync: false,
		concurrentWriters: true,
		crossProcessLock: true,
	});

	const pinned = new AsyncLocalStorage<Pin>();
	const configured = new WeakSet<PgPoolClientLike>();

	const acquire = async (): Promise<PgPoolClientLike> => {
		const client = await guard(() => pool.connect());
		if (setSearchPath !== undefined && !configured.has(client)) {
			try {
				// Outside any transaction, so a later ROLLBACK cannot undo it.
				await send(client, setSearchPath);
			} catch (error) {
				client.release(error as Error);
				throw error;
			}
			configured.add(client);
		}
		return client;
	};

	/** The text and the bound values of one statement; a `TypeError` when refused. */
	const prepare = (
		statement: Sql | string,
		params: readonly unknown[] | undefined,
	): { text: string; values: unknown[] } => {
		const rendered = statementOf(statement, params, "pg");
		return { text: rendered.text, values: normalizeParams(rendered.params, "pg") };
	};

	const run = async <T>(
		client: PgClientLike,
		text: string,
		values: unknown[],
	): Promise<QueryResult<T>> => resultOf<T>(await send(client, text, values));

	/**
	 * The pin a statement issued here belongs to. An ended transaction is no transaction
	 * (its client is back with the pool, or back with the section it ran in), so a context
	 * that outlived one falls through to whatever it was opened inside.
	 */
	const currentPin = (): Pin | undefined => {
		let pin = pinned.getStore();
		while (pin !== undefined && !pin.open) pin = pin.parent;
		return pin;
	};

	/** Whether this context already holds the lock `name`, through any open pin. */
	const holds = (pin: Pin | undefined, name: string): boolean => {
		for (let at = pin; at !== undefined; at = at.parent) {
			if (at.open && at.held.has(name)) return true;
		}
		return false;
	};

	/** Sections whose connection a failed `ROLLBACK` left in an unknown state. */
	const brokenSections = new WeakMap<Pin, Error>();

	/**
	 * Run `work` on a pin's client after everything that took a turn there before it. It
	 * no longer counts as waiting by the time its answer is out.
	 */
	const onTurn = <T>(pin: Pin, work: () => Promise<T>): Promise<T> => {
		pin.waiting++;
		const run = pin.turn.then(async () => {
			try {
				return await work();
			} finally {
				pin.waiting--;
			}
		});
		pin.turn = run.then(settled, settled);
		return run;
	};

	/**
	 * `work` in an open transaction or savepoint: at once, or in its turn while a
	 * savepoint opened there runs or anything waits for one. It then neither runs inside
	 * that savepoint nor goes with its rollback.
	 */
	const inScope = <T>(scope: Pin, work: () => Promise<T>): Promise<T> =>
		scope.waiting > 0 ? onTurn(scope, work) : work();

	/**
	 * End a transaction or a savepoint whose callback has settled. Whatever the callback
	 * left running is in the enclosing pin from here on, or takes a connection of its own.
	 * A savepoint opened in it and not awaited, and what waits behind one, finishes first:
	 * it would otherwise run on after the `COMMIT`, outside any transaction.
	 */
	const leave = async (scope: Pin): Promise<void> => {
		scope.open = false;
		while (scope.waiting > 0) await scope.turn;
	};

	/** Run `work` on a connection of its own, checked out for it and released after. */
	const onOwnClient = async <T>(
		work: (client: PgPoolClientLike) => Promise<T>,
	): Promise<T> => {
		const client = await acquire();
		try {
			return await work(client);
		} finally {
			client.release();
		}
	};

	const query = async <T = Row>(
		statement: Sql | string,
		params?: readonly unknown[],
	): Promise<QueryResult<T>> => {
		const { text, values } = prepare(statement, params);
		// Inside a transaction the pinned client is the only connection in play: never
		// reach for the pool here, or a pool of one would deadlock against itself. Inside
		// a section the same holds, and the statement waits for any transaction open on
		// the section's client rather than landing inside it.
		const pin = currentPin();
		if (pin === undefined)
			return onOwnClient((client) => run<T>(client, text, values));
		const work = (): Promise<QueryResult<T>> => run<T>(pin.client, text, values);
		return pin.kind === "exclusive" ? onTurn(pin, work) : inScope(pin, work);
	};

	const exec = async (script: string): Promise<void> => {
		if (typeof script !== "string") {
			throw new TypeError(`exec(script) takes SQL text, got ${describe(script)}`);
		}
		// No parameters: one simple query, which may hold any number of statements.
		const runScript = async (client: PgClientLike): Promise<void> => {
			await send(client, script);
		};
		const pin = currentPin();
		if (pin === undefined) return onOwnClient(runScript);
		const work = (): Promise<void> => runScript(pin.client);
		return pin.kind === "exclusive" ? onTurn(pin, work) : inScope(pin, work);
	};

	/**
	 * `BEGIN` … `COMMIT` on `client`, with `fn` running in the transaction's context.
	 * `onBroken` hears of a failed `ROLLBACK`, after which the connection's state is
	 * unknown and its owner must destroy it rather than reuse it.
	 */
	const runTransaction = async <T>(
		client: PgPoolClientLike,
		parent: Pin | undefined,
		fn: (tx: Driver) => Promise<T>,
		readOnly: boolean,
		onBroken: (error: Error) => void,
	): Promise<T> => {
		const tx: Pin = {
			client,
			kind: "transaction",
			open: true,
			parent,
			held: new Set(),
			turn: Promise.resolve(),
			waiting: 0,
			depth: 0,
		};
		// Set once the server has ended the transaction itself: no ROLLBACK to send.
		let ended = false;
		try {
			await send(client, readOnly ? BEGIN_READ_ONLY : "begin");
			try {
				let result: T;
				try {
					result = await pinned.run(tx, () => fn(driver));
				} finally {
					// Before COMMIT or ROLLBACK: whatever the callback left running takes
					// a connection of its own from here on.
					await leave(tx);
				}
				const { command } = await send(client, "commit");
				if (command !== "COMMIT") {
					ended = true;
					throw notCommitted(command);
				}
				return result;
			} catch (error) {
				if (!ended) {
					try {
						await send(client, "rollback");
					} catch (rollbackError) {
						// Keep the original failure; a failed ROLLBACK is a symptom, not the
						// cause. But the connection's state is now unknown: destroy it
						// rather than hand it back to the pool.
						onBroken(rollbackError as Error);
					}
				}
				throw error;
			}
		} finally {
			tx.open = false;
		}
	};

	const transaction = async <T>(
		fn: (tx: Driver) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T> => {
		const readOnly = readOnlyOf(options);
		assertCallback(fn, "transaction(fn)");
		const pin = currentPin();
		// Nested: the open transaction is the transaction, as it was opened.
		if (inTransaction(pin)) return fn(driver);
		// Inside a section: on the section's client, when its turn comes.
		if (pin !== undefined) {
			const section = pin;
			return onTurn(section, () =>
				runTransaction(section.client, section, fn, readOnly, (error) => {
					brokenSections.set(section, error);
				}),
			);
		}
		const client = await acquire();
		let broken: Error | undefined;
		try {
			return await runTransaction(client, undefined, fn, readOnly, (error) => {
				broken = error;
			});
		} finally {
			client.release(broken);
		}
	};

	/**
	 * `fn` in a savepoint of `parent`, on its client, in a context of its own. Called in
	 * `parent`'s turn: nothing else of that transaction runs until it has settled.
	 */
	const runSavepoint = async <T>(
		parent: Pin,
		fn: (tx: Driver) => Promise<T>,
	): Promise<T> => {
		const { client } = parent;
		const scope: Pin = {
			client,
			kind: "savepoint",
			open: true,
			parent,
			held: new Set(),
			turn: Promise.resolve(),
			waiting: 0,
			depth: parent.depth + 1,
		};
		// Set once the callback resolved: a refusal after that is the savepoint's own.
		let resolved = false;
		let result: T;
		try {
			result = await savepointBy(
				(text) => send(client, text),
				savepointName(scope.depth),
				async () => {
					let value: T;
					try {
						value = await pinned.run(scope, () => fn(driver));
					} finally {
						// Before RELEASE or ROLLBACK TO: whatever the callback left
						// running is in the enclosing transaction from here on.
						await leave(scope);
					}
					resolved = true;
					return value;
				},
			);
		} catch (error) {
			// Postgres refuses to release a savepoint in a transaction a failed statement
			// aborted: the callback caught that statement's error and resolved. It has
			// been rolled back to, which recovered the transaction.
			if (resolved && error instanceof TransactionAbortedError)
				throw notKept(error);
			throw error;
		}
		// A lock taken inside a savepoint that was kept is the transaction's, to its end.
		for (const name of scope.held) parent.held.add(name);
		return result;
	};

	const savepoint = async <T>(fn: (tx: Driver) => Promise<T>): Promise<T> => {
		assertCallback(fn, "savepoint(fn)");
		const pin = currentPin();
		// Outside a transaction there is none to save a point in: the unit is one.
		if (pin === undefined || pin.kind === "exclusive") return transaction(fn);
		// In its turn: after a savepoint opened there before it, and before whatever the
		// transaction issues next.
		return onTurn(pin, () => runSavepoint(pin, fn));
	};

	/** Lock statements on `client`, each guarded, and each in its turn when one is given. */
	const lockStatement =
		(
			client: PgClientLike,
			turn: <R>(work: () => Promise<R>) => Promise<R> = (work) => work(),
		): LockStatement =>
		(text, values) =>
			turn(() => send(client, text, values));

	const exclusive = async <T>(
		name: string,
		fn: (tx: Driver) => Promise<T>,
	): Promise<T> => {
		assertLockName(name);
		assertCallback(fn, "exclusive(name, fn)");
		const pin = currentPin();
		// Re-entrant: this context already holds it.
		if (holds(pin, name)) return fn(driver);

		// Inside a transaction: the transaction holds it, to its end. Postgres cannot
		// release a transaction-scoped lock any earlier, except with the savepoint it was
		// taken in, when that is rolled back to.
		if (pin !== undefined && pin.kind !== "exclusive") {
			const tx = pin;
			const statement = lockStatement(tx.client, (work) => inScope(tx, work));
			const key = await lockKeyOf(statement, name);
			await takeLock(statement, key, "transaction");
			tx.held.add(name);
			return fn(driver);
		}

		// Another name inside a section: on the section's own client, which holds both.
		if (pin !== undefined) {
			const section = pin;
			const statement = lockStatement(section.client, (work) =>
				onTurn(section, work),
			);
			const key = await lockKeyOf(statement, name);
			await takeLock(statement, key, "session");
			section.held.add(name);
			try {
				return await fn(driver);
			} finally {
				section.held.delete(name);
				await unlock(statement, key);
			}
		}

		const client = await acquire();
		const section: Pin = {
			client,
			kind: "exclusive",
			open: true,
			parent: undefined,
			held: new Set([name]),
			turn: Promise.resolve(),
			waiting: 0,
			depth: 0,
		};
		// Set when the connection must be destroyed rather than reused: destroying it is
		// also what releases a session lock that could not be released by statement.
		let destroy: Error | undefined;
		const statement = lockStatement(client);
		try {
			let key: LockKey;
			try {
				key = await lockKeyOf(statement, name);
				await takeLock(statement, key, "session");
			} catch (error) {
				// Whether the lock was taken is unknown.
				destroy = error as Error;
				throw error;
			}
			try {
				return await pinned.run(section, () => fn(driver));
			} finally {
				// Whatever `fn` left running takes a connection of its own from here on;
				// what it already queued on this client finishes before the lock goes.
				section.open = false;
				await section.turn;
				try {
					await unlock(statement, key);
				} catch (error) {
					destroy = error as Error;
				}
			}
		} finally {
			client.release(brokenSections.get(section) ?? destroy);
		}
	};

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		if (currentPin() !== undefined) {
			// `pool.end()` waits for every checked-out connection, this one included, and
			// this one is released only once the caller's callback, which awaits it, ends.
			return Promise.reject(
				new TypeError(
					"close() cannot be called inside a transaction or an exclusive section",
				),
			);
		}
		closing = guard(() => pool.end());
		return closing;
	};

	// One object: the `tx` every callback receives is this driver.
	const driver: Driver = {
		dialect: "pg",
		adapter: "pg",
		capabilities,
		query,
		exec,
		transaction,
		savepoint,
		exclusive,
		close,
	};
	return driver;
}

/** A pool, refused before anything starts when it is not shaped like one. */
function assertPool(pool: unknown): asserts pool is PgPoolLike {
	const shaped =
		typeof pool === "object" &&
		pool !== null &&
		["connect", "end", "on", "listenerCount"].every(
			(method) => typeof (pool as Record<string, unknown>)[method] === "function",
		);
	if (!shaped) {
		throw new TypeError("createPgDriver(pool) takes a node-postgres pg.Pool");
	}
}

/** A callback, refused before anything starts when it is not a function. */
function assertCallback(fn: unknown, call: string): void {
	if (typeof fn !== "function") {
		throw new TypeError(`${call} takes a function, got ${describe(fn)}`);
	}
}
