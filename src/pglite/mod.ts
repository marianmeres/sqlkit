/**
 * The PGlite adapter (`./pglite`): a `Driver` over a PGlite instance the host created, or
 * anything shaped like one (`PgliteLike`). PGlite is Postgres compiled to WebAssembly,
 * running in this process: Postgres semantics without a server, which is what makes it the
 * in-memory database for tests of code that runs on Postgres in production.
 *
 * PGlite is one connection, so this is a backend of the single-connection driver core, as
 * node:sqlite and one `pg.Client` are: everything takes its turn on the instance, and a
 * statement runs inside the open transaction only when that transaction's own callback
 * issued it. The capabilities say so: `{ sync: false, concurrentWriters: false,
 * crossProcessLock: false }`. Its dialect is `pg`: Postgres's SQL, `$1` placeholders,
 * `classifyPg` for its errors, which carry the server's SQLSTATE `code` and the
 * constraint, table and column it reported, as node-postgres's do.
 *
 * - `query()` is PGlite's `query`, which sends one statement on the extended protocol, so
 *   a text of several is refused by the server (`42601`) before any of it runs. `rowCount`
 *   is the number of rows for a statement that returns columns, and the number of rows
 *   affected otherwise. `exec()` is PGlite's `exec`: a simple query, any number of
 *   statements, no parameters.
 * - `transaction` is PGlite's own `transaction`, whose callback receives the transaction
 *   object the statements of the core's callback then go through. A read-only one runs
 *   `set transaction isolation level repeatable read, read only` first: one snapshot for
 *   every statement, and no write. On Postgres a failed statement aborts the whole
 *   transaction; the core refuses to commit one that a failure aborted
 *   (`TransactionAbortedError`), so PGlite rolls back instead of committing.
 * - `savepoint` is `SAVEPOINT`, `RELEASE` and `ROLLBACK TO`, sent through the
 *   transaction object PGlite handed out.
 * - No lock other processes honour: `exclusive` is the core's in-process queue, and a
 *   migrate run is one transaction.
 * - `close()` closes the instance (D13). A host that keeps its instance does not call it.
 *
 * Values bind by the parameter rule, then by PGlite's serializers, chosen by the type the
 * server inferred for each placeholder. Rows are read by PGlite's parsers: a `bytea` is a
 * `Uint8Array`, a `timestamptz` a `Date`, a `json` or `jsonb` the value it holds, and an
 * `int8` a number while it is a safe integer and a `bigint` beyond (node-postgres reads it
 * as text).
 *
 * Nothing is imported from PGlite: the shape the adapter takes is declared structurally, so
 * the package has no peer dependency and the host decides which PGlite it runs, how it is
 * stored and which extensions it loads.
 *
 * **Errors are typed by the core (D07):** the backend throws PGlite's errors as they are,
 * and the core wraps each in a `SqlError` of the kind `classifyPg` reads.
 */

import { classifyPg } from "../core/classify-pg.ts";
import type { Driver, QueryResult, Row } from "../core/contract.ts";
import { savepointBy } from "../core/savepoint.ts";
import type { Connection, SingleConnectionBackend } from "../single/backend.ts";
import { createSingleConnectionDriver } from "../single/driver.ts";

/** The part of a PGlite result the adapter reads. */
export interface PgliteResultsLike {
	/** One object per row. */
	rows: unknown[];
	/** The rows the statement wrote; absent where it wrote none. */
	affectedRows?: number;
	/** The columns of the rows, one entry each: none for a statement that returns none. */
	fields: readonly unknown[];
}

/** Statements, as PGlite and the transaction object it hands out both run them. */
export interface PgliteTransactionLike {
	/** One statement on the extended protocol, with its values. */
	query(query: string, params?: unknown[]): Promise<PgliteResultsLike>;
	/** A simple query: any number of statements, no values. */
	exec(query: string): Promise<unknown>;
}

/** A PGlite instance, as the adapter uses one. Only what the adapter calls is declared. */
export interface PgliteLike extends PgliteTransactionLike {
	/** Commits when the callback resolves, rolls back when it rejects. */
	transaction<T>(callback: (tx: PgliteTransactionLike) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

/**
 * How `transaction(fn, { readOnly: true })` begins, inside PGlite's `BEGIN`: one snapshot
 * for every statement, taken at the first, and no write. The same as the pool's.
 */
const SET_READ_ONLY = "set transaction isolation level repeatable read, read only";

/**
 * A driver over a PGlite instance the host created. `close()` closes the instance; a host
 * that keeps its instance does not call it.
 */
export function createPgliteDriver(db: PgliteLike): Driver {
	assertPglite(db);
	return createSingleConnectionDriver(pgliteBackend(db));
}

/** Statements through `target`: the instance, or a transaction it handed out. */
function connectionOver(target: PgliteTransactionLike): Connection {
	return {
		async run(text: string, params: readonly unknown[]): Promise<QueryResult<Row>> {
			return resultOf(await target.query(text, [...params]));
		},
		async exec(script: string): Promise<void> {
			await target.exec(script);
		},
	};
}

/** One PGlite instance as a single-connection backend. */
function pgliteBackend(db: PgliteLike): SingleConnectionBackend {
	return {
		dialect: "pg",
		adapter: "pglite",
		...connectionOver(db),

		async transaction<T>(
			fn: (inner: Connection) => Promise<T>,
			readOnly: boolean,
		): Promise<T> {
			/** What `fn` rejected with, boxed, so that even a rejected `undefined` counts. */
			let failed: { error: unknown } | undefined;
			try {
				return await db.transaction(async (tx) => {
					if (readOnly) await tx.exec(SET_READ_ONLY);
					try {
						return await fn(connectionOver(tx));
					} catch (error) {
						failed = { error };
						throw error;
					}
				});
			} catch (error) {
				// PGlite answers with the `ROLLBACK`'s failure when that fails too: a
				// symptom, not the cause, which is what `fn` rejected with.
				throw failed === undefined ? error : failed.error;
			}
		},

		savepoint<T>(fn: () => Promise<T>, inner: Connection, name: string): Promise<T> {
			// `inner` is the connection over the transaction object: the open transaction.
			return savepointBy((text) => inner.exec(text), name, fn);
		},

		classify: classifyPg,

		close(): Promise<void> {
			return db.close();
		},
	};
}

/** What `query()` answers, from what PGlite answered. */
function resultOf(result: PgliteResultsLike): QueryResult<Row> {
	const rows = result.rows as Row[];
	return {
		rows,
		rowCount: result.fields.length > 0 ? rows.length : (result.affectedRows ?? 0),
	};
}

/** A PGlite instance, refused before anything starts when it is not shaped like one. */
function assertPglite(db: unknown): asserts db is PgliteLike {
	const shaped =
		typeof db === "object" &&
		db !== null &&
		["query", "exec", "transaction", "close"].every(
			(method) => typeof (db as Record<string, unknown>)[method] === "function",
		);
	if (!shaped) {
		throw new TypeError("createPgliteDriver(db) takes a PGlite instance");
	}
}
