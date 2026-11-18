/**
 * The node:sqlite adapter (`./sqlite`): a `Driver` over a `DatabaseSync`, built into Node
 * since 22.5, so there is nothing to install and nothing to compile.
 *
 * It is a backend of the single-connection driver core: one handle is one connection, so
 * every statement takes its turn on it, and a statement runs inside an open transaction
 * only when that transaction's own callback issued it. A transaction is `BEGIN IMMEDIATE`;
 * a read-only one is a deferred `BEGIN` with `PRAGMA query_only` on for its length.
 *
 * Two entry points:
 *
 * - `createSqliteDriver(db)` takes a database the host opened and sets nothing on it: its
 *   busy timeout, journal mode and foreign keys are as the host opened it. `close()`
 *   closes it.
 * - `openSqlite(path, options)` opens one with the conventional settings (a busy timeout,
 *   WAL for a file) and hands it to `createSqliteDriver`.
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { classifySqlite } from "../core/classify-sqlite.ts";
import type { Driver, QueryResult, Row } from "../core/contract.ts";
import type { Connection, SingleConnectionBackend } from "../single/backend.ts";
import { createSingleConnectionDriver } from "../single/driver.ts";

/** How long `openSqlite` makes a statement wait for another connection's lock, by default. */
const BUSY_TIMEOUT_DEFAULT_MS = 5_000;

/** How `openSqlite` opens a database. */
export interface OpenSqliteOptions {
	/**
	 * Milliseconds a statement waits for another connection's lock on the same file
	 * before it fails with `database is locked`. A whole number from 0; 5000 by default,
	 * and 0 fails at once. The wait blocks the thread: the handle is synchronous.
	 */
	busyTimeout?: number;
}

/**
 * A driver over a database the host opened. Nothing is set on the handle: no busy
 * timeout, no journal mode, no pragma. `close()` closes it; a host that keeps its
 * database does not call it.
 */
export function createSqliteDriver(db: DatabaseSync): Driver {
	if (
		typeof db !== "object" ||
		db === null ||
		typeof (db as { prepare?: unknown }).prepare !== "function" ||
		typeof (db as { exec?: unknown }).exec !== "function"
	) {
		throw new TypeError("createSqliteDriver(db) takes a node:sqlite DatabaseSync");
	}
	return createSingleConnectionDriver(sqliteBackend(db));
}

/**
 * Opens a database with the conventional settings and answers a driver over it: a busy
 * timeout (`options.busyTimeout`, 5000 ms by default) and, for a file, the WAL journal,
 * which lets readers on other connections read while one writes. `path` is `":memory:"`
 * by default.
 */
export function openSqlite(path = ":memory:", options?: OpenSqliteOptions): Driver {
	const timeout = busyTimeoutOf(options?.busyTimeout);
	const db = new DatabaseSync(path, { timeout });
	try {
		// `location()` is null for a database that is not a file.
		if (db.location() !== null) db.exec("PRAGMA journal_mode = WAL");
		return createSqliteDriver(db);
	} catch (error) {
		db.close();
		throw error;
	}
}

/** A whole number of milliseconds from 0, or a `TypeError` naming the option. */
function busyTimeoutOf(value: unknown): number {
	if (value === undefined) return BUSY_TIMEOUT_DEFAULT_MS;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(
			`openSqlite: busyTimeout is a whole number of milliseconds from 0, got ${
				typeof value === "number" ? String(value) : `a ${typeof value}`
			}`,
		);
	}
	return value;
}

/** A statement prepared to hand back objects, whatever the host set on the handle. */
function prepare(db: DatabaseSync, text: string): StatementSync {
	const statement = db.prepare(text);
	statement.setReturnArrays(false);
	return statement;
}

/** node:sqlite hands back rows without a prototype; the contract's rows are plain. */
function plainRow(row: Record<string, unknown>): Row {
	return { ...row };
}

/** One node:sqlite handle as a single-connection backend. */
function sqliteBackend(db: DatabaseSync): SingleConnectionBackend {
	/** Undo the open transaction, keeping whatever failure led here. */
	const rollback = (): void => {
		if (!db.isTransaction) return;
		try {
			db.exec("ROLLBACK");
		} catch {
			// A failed ROLLBACK is a symptom, not the cause.
		}
	};

	const backend: SingleConnectionBackend = {
		dialect: "sqlite",
		adapter: "node:sqlite",

		run(text: string, params: readonly unknown[]): QueryResult<Row> {
			const statement = prepare(db, text);
			// The core bound every value by the parameter rule: each is one SQLite takes.
			const values = params as SQLInputValue[];
			// Rows or a count by what the statement returns, not by a keyword: a write
			// with `RETURNING` has columns, a plain one has none.
			if (statement.columns().length > 0) {
				const rows = statement.all(...values).map(plainRow);
				return { rows, rowCount: rows.length };
			}
			const { changes } = statement.run(...values);
			return { rows: [], rowCount: Number(changes) };
		},

		exec(script: string): void {
			db.exec(script);
		},

		async transaction<T>(
			fn: (inner: Connection) => Promise<T>,
			readOnly: boolean,
		): Promise<T> {
			// `query_only` is the connection's setting, on for exactly this transaction's
			// length: nothing else uses the connection meanwhile. A handle the host made
			// query-only stays so.
			// `Number`: a handle opened with `readBigInts` reads the pragma as `0n`.
			const restrict =
				readOnly &&
				Number(prepare(db, "PRAGMA query_only").get()?.query_only) === 0;
			if (restrict) db.exec("PRAGMA query_only = ON");
			try {
				// A read-only one takes no write lock: another connection to the file keeps
				// writing, and its snapshot starts at its first statement.
				db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
				let result: T;
				try {
					result = await fn(backend);
					db.exec("COMMIT");
				} catch (error) {
					rollback();
					throw error;
				}
				return result;
			} finally {
				if (restrict) db.exec("PRAGMA query_only = OFF");
			}
		},

		classify: classifySqlite,

		close(): void {
			if (db.isOpen) db.close();
		},
	};
	return backend;
}
