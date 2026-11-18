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
 * `exclusive()` pins a connection too, for a different reason: it holds a **session
 * advisory lock** keyed by the lock name and `current_schema()` (two schemas are two
 * deployments, and the test suite runs a schema per case), and every statement its
 * callback issues runs on that connection, so a pool of one cannot deadlock against it,
 * and `CREATE INDEX CONCURRENTLY` runs outside a transaction. A transaction opened inside
 * it runs on the same connection, and a statement issued from the section's own context
 * waits for that transaction rather than running inside it. Inside an open transaction it
 * takes the transaction-scoped lock on the pinned client.
 *
 * The lock is **polled** (`pg_try_advisory_lock`), never waited for in a statement. A
 * session blocked in `pg_advisory_lock` holds a snapshot, and `CREATE INDEX
 * CONCURRENTLY` in the session that holds the lock waits for every older snapshot to
 * end: the waiter and the holder wait for each other, and Postgres breaks the cycle by
 * killing one with `40P01`. Between polls the waiter holds no snapshot, so the build
 * finishes and the waiter takes its turn.
 *
 * `transaction(fn, { readOnly: true })` begins `REPEATABLE READ READ ONLY`: one snapshot,
 * taken at its first statement, for all of them: what a dump reads its pages in.
 *
 * `COMMIT` is checked, not trusted: Postgres answers the `COMMIT` of a transaction a failed
 * statement aborted with `ROLLBACK`, and no error. A callback that caught that statement's
 * error and returned normally would otherwise be reported as committed. A `ROLLBACK` that
 * failed leaves the connection in a state nobody knows, so it is destroyed, not handed
 * back to the pool.
 *
 * The pool's `error` event (an idle client the server dropped) is listened to, because a
 * pool nobody listens to ends the process on the first one. When the host listens too,
 * the driver stays quiet; when it is the only listener it reports the error through
 * `process.emitWarning`.
 *
 * `exec()` sends its script as one simple query, with no parameters, so it may hold any
 * number of statements.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
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
import { normalizeParams } from "../core/params.ts";
import { quoteIdent, type Sql } from "../core/sql.ts";
import type {
	PgClientLike,
	PgDriverOptions,
	PgPoolClientLike,
	PgPoolLike,
} from "./types.ts";

/**
 * How `transaction(fn, { readOnly: true })` begins: one snapshot for every statement, taken
 * at the first, and no write. `READ COMMITTED`, the default, takes one per statement.
 */
const BEGIN_READ_ONLY = "begin isolation level repeatable read, read only";

/** The first wait between two polls for an `exclusive` lock, in milliseconds. */
const LOCK_POLL_FIRST_MS = 10;
/** The longest wait between two polls: the doubling stops here. */
const LOCK_POLL_MAX_MS = 250;

/**
 * A pinned client and what it is pinned for: a transaction, or an `exclusive` section
 * holding a session advisory lock. One object per pin, shared by every context that
 * carries it, so closing it once closes it for all of them.
 */
interface Pin {
	readonly client: PgPoolClientLike;
	readonly kind: "transaction" | "exclusive";
	open: boolean;
	/** The section a transaction was opened inside, whose client it runs on. */
	readonly parent: Pin | undefined;
	/** The lock names held on this pin: until the section ends, or the transaction does. */
	readonly held: Set<string>;
	/** A section's own statements and transactions take turns on its one client. */
	turn: Promise<unknown>;
}

/** The two `int4` keys of one advisory lock: the name's and the schema's. */
type LockKey = readonly [number, number];

const settled = (): undefined => undefined;

/** What a `COMMIT` that did not commit is refused with. */
function notCommitted(command: string): Error {
	return new Error(
		`postgres answered COMMIT with ${command}: a statement inside the transaction ` +
			"failed, so nothing was committed; the callback caught that statement's error " +
			"and returned as if it had succeeded",
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
	const setSearchPath = searchPathOf(options);

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
		const client = await pool.connect();
		if (setSearchPath !== undefined && !configured.has(client)) {
			try {
				// Outside any transaction, so a later ROLLBACK cannot undo it.
				await client.query(setSearchPath);
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
	): Promise<QueryResult<T>> => {
		const result = await client.query(text, values);
		// Without parameters node-postgres sends a simple query, which runs every
		// statement of the text and answers one result each.
		if (Array.isArray(result)) {
			throw new TypeError(
				"query() runs one statement, and this text held several (each of them ran): " +
					"a script goes through exec()",
			);
		}
		return {
			rows: result.rows as T[],
			// `rowCount` is null for a statement that affects nothing countable.
			rowCount: result.rowCount ?? result.rows.length,
		};
	};

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

	/** Run `work` on a section's client after everything queued there before it. */
	const onTurn = <T>(section: Pin, work: () => Promise<T>): Promise<T> => {
		const run = section.turn.then(work, work);
		section.turn = run.then(settled, settled);
		return run;
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
		if (pin?.kind === "transaction") return run<T>(pin.client, text, values);
		if (pin !== undefined) return onTurn(pin, () => run<T>(pin.client, text, values));
		return onOwnClient((client) => run<T>(client, text, values));
	};

	const exec = async (script: string): Promise<void> => {
		if (typeof script !== "string") {
			throw new TypeError(`exec(script) takes SQL text, got ${describe(script)}`);
		}
		// No parameters: one simple query, which may hold any number of statements.
		const send = async (client: PgClientLike): Promise<void> => {
			await client.query(script);
		};
		const pin = currentPin();
		if (pin?.kind === "transaction") return send(pin.client);
		if (pin !== undefined) return onTurn(pin, () => send(pin.client));
		return onOwnClient(send);
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
		};
		// Set once the server has ended the transaction itself: no ROLLBACK to send.
		let ended = false;
		try {
			await client.query(readOnly ? BEGIN_READ_ONLY : "begin");
			try {
				let result: T;
				try {
					result = await pinned.run(tx, () => fn(driver));
				} finally {
					// Before COMMIT or ROLLBACK: whatever the callback left running takes
					// a connection of its own from here on.
					tx.open = false;
				}
				const { command } = await client.query("commit");
				if (command !== "COMMIT") {
					ended = true;
					throw notCommitted(command);
				}
				return result;
			} catch (error) {
				if (!ended) {
					try {
						await client.query("rollback");
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
		if (pin?.kind === "transaction") return fn(driver);
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

	/** The lock's two keys, computed once so a later `search_path` cannot move them. */
	const lockKeyOf = async (client: PgClientLike, name: string): Promise<LockKey> => {
		const { rows } = await client.query(
			"select hashtext($1) as a, hashtext(coalesce(current_schema(), '')) as b",
			[name],
		);
		const row = rows[0];
		if (row === undefined) throw new Error("postgres: hashtext() answered no row");
		return [Number(row.a), Number(row.b)];
	};

	/**
	 * Poll until the lock is taken: `pg_try_advisory_lock` (session) or
	 * `pg_try_advisory_xact_lock` (to the end of the open transaction). Never a blocking
	 * `pg_advisory_lock`: see the header for the deadlock that would be.
	 */
	const takeLock = async (
		client: PgClientLike,
		key: LockKey,
		scope: "session" | "transaction",
		turn: <T>(work: () => Promise<T>) => Promise<T>,
	): Promise<void> => {
		const fn =
			scope === "session" ? "pg_try_advisory_lock" : "pg_try_advisory_xact_lock";
		let wait = LOCK_POLL_FIRST_MS;
		for (;;) {
			const { rows } = await turn(() =>
				client.query(`select ${fn}($1, $2) as ok`, [...key]),
			);
			if (rows[0]?.ok === true) return;
			await sleep(wait);
			wait = Math.min(wait * 2, LOCK_POLL_MAX_MS);
		}
	};

	const unlock = async (client: PgClientLike, key: LockKey): Promise<void> => {
		await client.query("select pg_advisory_unlock($1, $2)", [...key]);
	};

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
		// release a transaction-scoped lock any earlier.
		if (pin?.kind === "transaction") {
			const tx = pin;
			const key = await lockKeyOf(tx.client, name);
			await takeLock(tx.client, key, "transaction", (work) => work());
			tx.held.add(name);
			return fn(driver);
		}

		// Another name inside a section: on the section's own client, which holds both.
		if (pin !== undefined) {
			const section = pin;
			const turn = <R>(work: () => Promise<R>): Promise<R> => onTurn(section, work);
			const key = await turn(() => lockKeyOf(section.client, name));
			await takeLock(section.client, key, "session", turn);
			section.held.add(name);
			try {
				return await fn(driver);
			} finally {
				section.held.delete(name);
				await turn(() => unlock(section.client, key));
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
		};
		// Set when the connection must be destroyed rather than reused: destroying it is
		// also what releases a session lock that could not be released by statement.
		let destroy: Error | undefined;
		try {
			let key: LockKey;
			try {
				key = await lockKeyOf(client, name);
				await takeLock(client, key, "session", (work) => work());
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
					await unlock(client, key);
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
		closing = (async (): Promise<void> => {
			await pool.end();
		})();
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

/** The `set search_path` statement `options.schema` asks for, or none. */
function searchPathOf(options: PgDriverOptions | undefined): string | undefined {
	if (options === undefined) return undefined;
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`createPgDriver(pool, options) takes an object, got ${describe(options)}`,
		);
	}
	const schema: unknown = options.schema;
	if (schema === undefined) return undefined;
	if (typeof schema !== "string" || schema === "") {
		throw new TypeError(
			`createPgDriver: schema is a non-empty string, got ${describe(schema)}`,
		);
	}
	return `set search_path to ${quoteIdent(schema)}`;
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
	if (typeof value === "string") return value === "" ? "an empty string" : "a string";
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
