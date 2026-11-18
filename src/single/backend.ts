/**
 * The backend seam of the single-connection driver core: what an adapter over one
 * connection provides, so that the core can supply everything that is not the database.
 *
 * node:sqlite, one `pg.Client`, PGlite and a Durable Object are each one connection, and
 * one connection has one rule: everything takes its turn, and a statement runs inside the
 * open transaction only when that transaction's own callback issued it. The rule is written
 * once, in `driver.ts`; a backend only runs what it is handed, when it is handed it.
 *
 * Transactions are callback-shaped at this seam, not `BEGIN` / `COMMIT` statements, because
 * one backend cannot be sent `BEGIN` at all: a Durable Object refuses every transaction
 * statement and offers a callback API instead.
 *
 * A backend over an engine that is synchronous underneath also gives a `SyncBackend`, the
 * same connection answering at once, and the core builds `driver.sync` over it.
 *
 * Imports only the core's types.
 */

import type { DialectName, QueryResult, Row } from "../core/contract.ts";
import type { SqlErrorInfo } from "../core/errors.ts";

/** A value, or a promise of one: a synchronous engine answers at once. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Statements on one connection. The core has already rendered the text in the dialect's
 * placeholder style and bound every parameter by the parameter rule; a connection runs
 * them as they are.
 */
export interface Connection {
	/**
	 * Run one statement. `rows` are plain objects; `rowCount` is the number of rows for a
	 * statement that returns columns, and the number of rows affected otherwise.
	 */
	run(text: string, params: readonly unknown[]): MaybePromise<QueryResult<Row>>;
	/** Run a script: any number of statements, no parameters, no result. */
	exec(script: string): MaybePromise<void>;
}

/** One connection to a database, under the single-connection driver core. */
export interface SingleConnectionBackend extends Connection {
	readonly dialect: DialectName;
	/** The `Driver.adapter` name: `"node:sqlite"`, `"pg-client"`, … */
	readonly adapter: string;
	/**
	 * Run `fn` in one transaction: commit when it resolves, roll back when it rejects, and
	 * answer with what `fn` answered, or with its rejection. A failed commit rolls back
	 * and rejects.
	 *
	 * `fn` receives the connection its statements go through: a backend whose library
	 * hands out a transaction object passes one over that object, the others pass
	 * themselves.
	 *
	 * The core calls it in the connection's turn, never twice at once, and never from
	 * inside an open transaction: a nested `transaction` is joined by the core.
	 */
	transaction<T>(fn: (inner: Connection) => Promise<T>, readOnly: boolean): Promise<T>;
	/**
	 * A lock other processes honour, where the database has one: what makes
	 * `capabilities.crossProcessLock` true. Resolves, once the lock is held, to its
	 * release.
	 *
	 * `inTransaction` is true when the core calls it from inside an open transaction,
	 * whose connection it is then to use, and whose end may be what releases the lock.
	 * Outside one the core calls it, and the release, in the connection's turn: nothing
	 * else runs on the connection until each has settled.
	 */
	lock?(name: string, inTransaction: boolean): Promise<() => Promise<void>>;
	/**
	 * Which kind of error a driver error is: the dialect's classifier. The core wraps
	 * whatever the backend throws with it, on both tiers (D07), so a backend throws its
	 * driver's errors as they are. A `TypeError` it throws is a refusal of its own and is
	 * not wrapped.
	 */
	classify(error: unknown): SqlErrorInfo;
	/** End the connection the adapter was given. The core calls it once. */
	close(): MaybePromise<void>;
}

/**
 * The same connection as a {@link SingleConnectionBackend}, synchronously: what the core
 * builds `driver.sync` over. A statement it runs while the backend's transaction is open
 * is part of that transaction, since it is the one connection; the core decides when
 * that may happen (rules S1–S6, `driver.ts`).
 */
export interface SyncBackend {
	/** Run one statement, as {@link Connection.run} does, and answer at once. */
	run(text: string, params: readonly unknown[]): QueryResult<Row>;
	/** Run a script: any number of statements, no parameters, no result. */
	exec(script: string): void;
	/**
	 * Run `fn` in one transaction: commit when it returns, roll back when it throws, and
	 * answer what `fn` answered, or throw what it threw. A failed commit rolls back and
	 * throws.
	 *
	 * The core calls it only when no transaction is open on the connection, and checks
	 * what `fn` answers before it returns: a thenable is a throw, so the backend rolls
	 * back.
	 */
	transaction<T>(fn: () => T, readOnly: boolean): T;
}
