/**
 * The driver contract: the two interfaces every adapter implements, the small helpers
 * every adapter calls before a statement reaches its database, and `isDriver`, which tells
 * a driver from whatever else a caller was handed.
 *
 * `Driver` is asynchronous and every adapter has one. `SyncDriver` is its synchronous
 * sibling, exposed as `driver.sync` by an adapter whose engine is synchronous underneath:
 * an async callback returns at its first `await`, so it cannot run inside a synchronous
 * transaction, and code that needs one needs the synchronous surface.
 *
 * The rules the conformance suite holds every adapter to:
 *
 * - **R1** `query` and `exec` always answer with a promise: a failing statement rejects,
 *   it never throws at the call.
 * - **R2** `rowCount` is as {@link QueryResult} says, for a `SELECT`, a plain write and a
 *   write with `RETURNING`.
 * - **R3** `transaction` commits when `fn` resolves and rolls back when it rejects. On
 *   `pg`, where a failed statement aborts the transaction, a callback that swallowed the
 *   failure and resolved gets a rejection, not a silent rollback. SQLite has no aborted
 *   state: the rest of the transaction commits.
 * - **R4** A nested `transaction` joins the open one, as it was opened.
 * - **R5** A statement belongs to the transaction whose callback issued it, and to no
 *   other: one from elsewhere neither sees its uncommitted rows nor goes with its rollback.
 * - **R6** "Inside" ends when the callback settles: a promise that outlives its
 *   transaction writes outside it.
 * - **R7** `readOnly` reads one snapshot and refuses a write.
 * - **R8** `exclusive` serializes callers of one name, is re-entrant, lets two names run
 *   together, releases on rejection, and inside an open transaction belongs to that
 *   transaction.
 * - **R9** `exec` runs every statement of a script and joins the open transaction.
 * - **R10** Parameters follow the one parameter rule (`params.ts`). Rows are plain
 *   objects. Bytes read back as a `Uint8Array` (node-postgres's `Buffer` is one).
 * - **R11** `query` runs one statement: a text holding more is refused before any of it
 *   runs, with a `TypeError` where the adapter sees it, or the database's own refusal
 *   where the database does. Blanks, semicolons and comments after it are not a
 *   statement. A script goes through `exec`.
 * - **R12** `savepoint` runs `fn` as a unit of the open transaction: kept when `fn`
 *   resolves, undone alone when it rejects, and the transaction goes on either way.
 *   Savepoints nest, and two opened at once run one after the other. A statement issued
 *   in the transaction from outside the savepoint's callback waits for the savepoint to
 *   end. On `pg` a callback that swallowed a failure gets a rejection, and the savepoint
 *   is undone. Outside a transaction a savepoint is a transaction.
 *
 * Runtime-neutral: imports only the fragment builder.
 */

import { isSql, render, type Sql } from "./sql.ts";

/** The SQL a driver speaks. It decides the placeholder style and what a value binds as. */
export type DialectName = "pg" | "sqlite";

/** A row as a driver hands it back: a plain object, one property per selected column. */
export type Row = Record<string, unknown>;

/** The result of one statement. */
export interface QueryResult<T = Row> {
	rows: T[];
	/**
	 * Rows returned, for a statement that returns rows (a `SELECT`, a write with
	 * `RETURNING`); rows affected, for a plain `INSERT`, `UPDATE` or `DELETE`. For any other
	 * statement (DDL, a `SET`, a pragma) it is a number and nothing more: SQLite reports
	 * the previous write's count there.
	 */
	rowCount: number;
}

/** How {@link Driver.transaction} opens a transaction. */
export interface TransactionOptions {
	/**
	 * Read one consistent snapshot and write nothing: what a dump needs, so a row written
	 * while it runs is either wholly in it or not in it at all. `false` by default.
	 * Anything but a boolean is a `TypeError`.
	 *
	 * - **Postgres** opens `REPEATABLE READ READ ONLY`: every statement reads the database
	 *   as it was at the first one, whatever commits meanwhile.
	 * - **SQLite** opens a deferred `BEGIN` rather than `BEGIN IMMEDIATE`, so it takes no
	 *   write lock and another connection to the file keeps writing; its snapshot starts
	 *   at the first statement. `query_only` is on for its length.
	 *
	 * A write inside it is refused on both, as a `ReadOnlyError`.
	 */
	readonly readOnly?: boolean;
}

/** Facts about an adapter that its dialect name does not already tell. */
export interface Capabilities {
	/** `driver.sync` exists. */
	readonly sync: boolean;
	/** More than one connection: a statement outside a transaction runs beside it. */
	readonly concurrentWriters: boolean;
	/** `exclusive()` also excludes other processes on the same database. */
	readonly crossProcessLock: boolean;
}

/**
 * A database, asynchronously. Every adapter implements it.
 *
 * `transaction` is the only place a connection is pinned: a `BEGIN` sent through a pool is
 * not a transaction. A nested call joins the open transaction rather than opening a second
 * one.
 *
 * A statement belongs to the transaction whose callback issued it, and to no other. One
 * issued from outside an open transaction never runs inside it (a pool takes another
 * connection, a single connection makes it wait its turn), so it neither sees that
 * transaction's uncommitted rows nor goes with its rollback. "Inside" is the callback's
 * async context, and it ends when the callback settles: a promise that outlives its
 * transaction runs whatever it issues afterwards as any other caller would.
 *
 * The `tx` a callback receives is this driver itself: the context decides which
 * transaction a statement is in, not the handle it was issued through.
 */
export interface Driver {
	readonly dialect: DialectName;
	/** Which adapter this is: `"pg"`, `"pg-client"`, `"node:sqlite"`, `"pglite"`, … */
	readonly adapter: string;
	readonly capabilities: Capabilities;
	/**
	 * Run one statement: a fragment, or text with its parameters. Always answers with a
	 * promise: a failing statement rejects, never throws at the call. A text of several
	 * statements is refused before any of them runs; a script goes through `exec`.
	 */
	query<T = Row>(statement: Sql): Promise<QueryResult<T>>;
	query<T = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
	/**
	 * Run a script: any number of statements, no parameters, no result. Inside an open
	 * transaction it is part of that transaction.
	 */
	exec(script: string): Promise<void>;
	/**
	 * Run `fn` in one transaction: committed when it resolves, rolled back when it
	 * rejects. A `COMMIT` the database did not carry out (Postgres, after a statement
	 * inside failed and `fn` caught the error) rejects too.
	 *
	 * `options` shape a transaction this call opens. A nested call joins the open
	 * transaction as it is, whatever it asks for.
	 */
	transaction<T>(
		fn: (tx: Driver) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T>;
	/**
	 * Run `fn` while holding the lock `name`, which every other caller of `exclusive` with
	 * that name waits for: in this process and, where `capabilities.crossProcessLock` is
	 * true, in every process connected to the same database.
	 *
	 * - **Re-entrant.** A call from inside `fn` with the same name runs at once.
	 * - **Inside an open transaction** the transaction is what holds it. Postgres takes a
	 *   transaction-scoped lock on the transaction's connection, held until it commits or
	 *   rolls back; a single connection runs `fn` at once, because its open transaction
	 *   already excludes every other writer and waiting there could wait for itself.
	 * - **Outside one**, a pool pins one connection for the whole of `fn` and runs every
	 *   statement `fn` issues on it, a transaction included, so a pool of one works, and a
	 *   statement that refuses to run in a transaction (`CREATE INDEX CONCURRENTLY`) can.
	 *
	 * `fn` receives this driver, as `transaction`'s callback does. Rejects with `fn`'s
	 * rejection; the lock is released either way.
	 */
	exclusive<T>(name: string, fn: (tx: Driver) => Promise<T>): Promise<T>;
	/**
	 * Run `fn` as a unit that is kept or undone as a whole, without ending the transaction
	 * it is in: what a step that may fail needs, when the work before it is to stay.
	 *
	 * - **Inside an open transaction** it is a savepoint of that transaction: released
	 *   when `fn` resolves, rolled back to when it rejects, with `fn`'s rejection. The
	 *   transaction goes on either way. On Postgres too, where a failed statement aborts
	 *   the transaction: rolling back to the savepoint is what lifts that.
	 * - **Outside one** there is no transaction to save a point in, so the unit is a
	 *   transaction of its own: `transaction(fn)`. Code that is handed a driver, and does
	 *   not know whether its caller opened a transaction, gets one unit either way.
	 * - **Savepoints nest**: one inside another is undone alone, and goes with the outer
	 *   one when that is undone. They do not overlap: a second one opened in the same
	 *   transaction while the first is running waits for it, and so does any statement
	 *   issued there from outside the first one's callback, so that it neither runs
	 *   inside that savepoint nor goes with its rollback.
	 * - **A failure the callback swallowed** (Postgres): `fn` caught a failed statement's
	 *   error and resolved. The savepoint cannot be kept, so it is rolled back to, and
	 *   the call rejects with `TransactionAbortedError`; the transaction goes on. SQLite
	 *   undoes the failed statement alone and keeps the rest, as in a transaction.
	 *
	 * `fn` receives this driver, as `transaction`'s callback does. A promise that outlives
	 * its savepoint runs whatever it issues afterwards in the transaction, outside the
	 * savepoint.
	 */
	savepoint<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
	/** End the client the adapter was given. Idempotent. */
	close(): Promise<void>;
	/** The synchronous tier, on an adapter whose engine is synchronous underneath. */
	readonly sync?: SyncDriver;
}

/**
 * A database, synchronously: `Driver`'s sibling on an engine that is synchronous
 * underneath. Its transaction callback is synchronous too, which is the point of it: an
 * async one would return at its first `await` and leave the transaction open.
 *
 * A refused call throws its `TypeError` at the call. The sync tier is the same connection
 * as the async one, so the two refuse each other where a call would land in the wrong
 * transaction:
 *
 * - **S1** A transaction or savepoint callback that returns a thenable is undone, with a
 *   `TypeError`.
 * - **S2** A nested `transaction` joins the open one, as it was opened.
 * - **S3** A sync call from inside an open async transaction's own callback runs inside
 *   that transaction; a sync `savepoint` there is a savepoint of it.
 * - **S4** A sync call while an async transaction is open, from anywhere else, is a
 *   `TypeError`. So is one from inside that transaction while a savepoint opened there
 *   is still running, from outside the savepoint's callback: it could only run inside
 *   that savepoint.
 * - **S5** An async call from inside a sync transaction's or savepoint's callback rejects
 *   with a `TypeError`: it could only run after the callback returned.
 * - **S6** With no transaction open, a sync call runs at once, ahead of queued async work.
 */
export interface SyncDriver {
	readonly dialect: DialectName;
	readonly adapter: string;
	readonly capabilities: Capabilities;
	query<T = Row>(statement: Sql): QueryResult<T>;
	query<T = Row>(text: string, params?: readonly unknown[]): QueryResult<T>;
	exec(script: string): void;
	transaction<T>(fn: (tx: SyncDriver) => T, options?: TransactionOptions): T;
	/**
	 * `Driver.savepoint`, synchronously: a savepoint of the open transaction, kept when
	 * `fn` returns and undone alone when it throws, with what it threw; a transaction of
	 * its own when none is open.
	 */
	savepoint<T>(fn: (tx: SyncDriver) => T): T;
}

/** A {@link Driver}'s methods. */
const DRIVER_METHODS = [
	"query",
	"exec",
	"transaction",
	"exclusive",
	"savepoint",
	"close",
] as const;

/** A {@link SyncDriver}'s methods. */
const SYNC_METHODS = ["query", "exec", "transaction", "savepoint"] as const;

/** The facts a {@link Capabilities} states. */
const CAPABILITIES = ["sync", "concurrentWriters", "crossProcessLock"] as const;

/**
 * What `value` lacks to be a {@link Driver}, each as a refusal names it (`"savepoint()"`,
 * `"capabilities.sync"`); nothing for a driver. `undefined` for a value that is not an
 * object at all.
 *
 * It is the contract as this version states it, member by member, and no more than their
 * types: a driver built before a member was added lacks that member, here as in the
 * type.
 */
export function missingFromDriver(value: unknown): string[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const driver = value as Record<string, unknown>;
	const missing: string[] = [];
	if (driver.dialect !== "pg" && driver.dialect !== "sqlite") {
		missing.push('dialect of "pg" or "sqlite"');
	}
	if (typeof driver.adapter !== "string") missing.push("adapter name");
	const capabilities = driver.capabilities;
	if (typeof capabilities !== "object" || capabilities === null) {
		missing.push("capabilities");
	} else {
		for (const fact of CAPABILITIES) {
			if (typeof (capabilities as Record<string, unknown>)[fact] !== "boolean") {
				missing.push(`capabilities.${fact}`);
			}
		}
	}
	for (const method of DRIVER_METHODS) {
		if (typeof driver[method] !== "function") missing.push(`${method}()`);
	}
	// The sync tier is optional; one that is there has to be one.
	const sync = driver.sync;
	if (sync !== undefined) {
		for (const method of SYNC_METHODS) {
			if (
				typeof sync !== "object" ||
				sync === null ||
				typeof (sync as Record<string, unknown>)[method] !== "function"
			) {
				missing.push(`sync.${method}()`);
			}
		}
	}
	return missing;
}

/**
 * Whether `value` is a {@link Driver}: what a library asks when its `db` option takes a
 * driver or something else (a pool, a database handle), before it decides which it got.
 *
 * By its shape, not by a mark: `Driver` is an interface, so one built by another copy of
 * this package, or by an adapter written outside it, is a driver all the same. The shape
 * is the contract as this version states it, every member of it: a driver built before
 * `savepoint` was added is not one, as the type would not take it either. A `SyncDriver`
 * is not one: it has no `exclusive` and no `close`.
 */
export function isDriver(value: unknown): value is Driver {
	return missingFromDriver(value)?.length === 0;
}

/**
 * Whether a {@link TransactionOptions} asks for a read-only transaction. Anything but a
 * boolean (or nothing) is refused: a truthy string would otherwise open a transaction the
 * caller did not ask for, or not open the one they did.
 */
export function readOnlyOf(options: TransactionOptions | undefined): boolean {
	const value: unknown = options?.readOnly;
	if (value === undefined) return false;
	if (typeof value !== "boolean") {
		throw new TypeError(
			`transaction(fn, { readOnly }) takes a boolean, got ${describe(value)}`,
		);
	}
	return value;
}

/**
 * The name an `exclusive` call locks, refused when it is not a non-empty string: an empty
 * or a missing name would quietly make every caller share one lock.
 */
export function assertLockName(name: unknown): asserts name is string {
	if (typeof name !== "string" || name === "") {
		throw new TypeError(
			`exclusive(name, fn) takes a non-empty lock name, got ${describe(name)}`,
		);
	}
}

/**
 * The text and the parameters of one `query` call, in the dialect's placeholder style.
 * Every adapter calls it first. A fragment is rendered; text is passed through with its
 * parameters (a copy, never the caller's array). Parameters given together with a fragment
 * are refused, since a fragment carries its own: the call is a mistake either way.
 *
 * The values are not yet bound by the parameter rule; `normalizeParams` does that.
 */
export function statementOf(
	statement: Sql | string,
	params: readonly unknown[] | undefined,
	dialect: DialectName,
): { text: string; params: unknown[] } {
	if (dialect !== "pg" && dialect !== "sqlite") {
		throw new TypeError(`unknown dialect ${describe(dialect)}`);
	}
	if (isSql(statement)) {
		if (params !== undefined) {
			throw new TypeError(
				"query(fragment) takes no params: a fragment carries its own values",
			);
		}
		return render(statement, dialect);
	}
	if (typeof statement !== "string") {
		throw new TypeError(
			`query takes a fragment built by sql\`\` or SQL text, got ${describe(statement)}`,
		);
	}
	if (params === undefined) return { text: statement, params: [] };
	if (!Array.isArray(params)) {
		throw new TypeError(
			`query(text, params) takes an array, got ${describe(params)}`,
		);
	}
	return { text: statement, params: Array.from(params) };
}

/** A short, safe description of a value for an error message. */
function describe(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "object") return "an object";
	if (typeof value === "symbol" || typeof value === "function")
		return `a ${typeof value}`;
	return String(value);
}
