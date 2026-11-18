/**
 * The node:sqlite adapter (`./sqlite`): a `Driver` over a `DatabaseSync`, built into Node
 * since 22.5, so there is nothing to install and nothing to compile.
 *
 * It is a backend of the single-connection driver core: one handle is one connection, so
 * every statement takes its turn on it, and a statement runs inside an open transaction
 * only when that transaction's own callback issued it. A transaction is `BEGIN IMMEDIATE`;
 * a read-only one is a deferred `BEGIN` with `PRAGMA query_only` on for its length.
 *
 * The handle is synchronous, so the driver has a sync tier too: `driver.sync`, the same
 * handle answering at once, with a transaction whose callback is synchronous.
 *
 * Two entry points:
 *
 * - `createSqliteDriver(db)` takes a database the host opened and sets nothing on it: its
 *   busy timeout, journal mode and foreign keys are as the host opened it. `close()`
 *   closes it.
 * - `openSqlite(path, options)` opens one with the conventional settings (a busy timeout,
 *   WAL for a file) and hands it to `createSqliteDriver`.
 *
 * Errors are typed at the boundary (D07): what node:sqlite throws, from a statement, a
 * transaction's `BEGIN` or `COMMIT`, or opening the file in `openSqlite`, comes out as a
 * `SqlError` of the kind `classifySqlite` reads, with node:sqlite's error as `cause`. The
 * single-connection core wraps everything the handle does once it is a driver; only
 * opening it is wrapped here.
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { classifySqlite } from "../core/classify-sqlite.ts";
import type { Driver, QueryResult, Row } from "../core/contract.ts";
import { toSqlError } from "../core/errors.ts";
import type {
	Connection,
	SingleConnectionBackend,
	SyncBackend,
} from "../single/backend.ts";
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
 * database does not call it. `driver.sync` is the same handle, synchronously.
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
	const { backend, sync } = sqliteBackends(db);
	return createSingleConnectionDriver(backend, sync);
}

/**
 * Opens a database with the conventional settings and answers a driver over it: a busy
 * timeout (`options.busyTimeout`, 5000 ms by default) and, for a file, the WAL journal,
 * which lets readers on other connections read while one writes. `path` is `":memory:"`
 * by default.
 *
 * A file that cannot be opened, or a journal that cannot be switched, throws a `SqlError`
 * with node:sqlite's error as `cause`; a path that is not one is a `TypeError`.
 */
export function openSqlite(path = ":memory:", options?: OpenSqliteOptions): Driver {
	const timeout = busyTimeoutOf(options?.busyTimeout);
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(path, { timeout });
	} catch (error) {
		throw wrap(error);
	}
	try {
		// `location()` is null for a database that is not a file.
		if (db.location() !== null) db.exec("PRAGMA journal_mode = WAL");
		return createSqliteDriver(db);
	} catch (error) {
		db.close();
		throw wrap(error);
	}
}

/**
 * What node:sqlite threw, as the contract has it: a `SqlError` of its kind, with the
 * driver's error as `cause` (D07). A `TypeError` is a programming mistake and stays one.
 */
function wrap(error: unknown): unknown {
	return error instanceof TypeError
		? error
		: toSqlError(error, "sqlite", classifySqlite);
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

/** One node:sqlite handle as a single-connection backend, and as its sync tier's. */
function sqliteBackends(db: DatabaseSync): {
	backend: SingleConnectionBackend;
	sync: SyncBackend;
} {
	const run = (text: string, params: readonly unknown[]): QueryResult<Row> => {
		const statement = prepare(db, text);
		// The core bound every value by the parameter rule: each is one SQLite takes.
		const values = params as SQLInputValue[];
		// Rows or a count by what the statement returns, not by a keyword: a write with
		// `RETURNING` has columns, a plain one has none.
		if (statement.columns().length > 0) {
			const rows = statement.all(...values).map(plainRow);
			return { rows, rowCount: rows.length };
		}
		const { changes } = statement.run(...values);
		return { rows: [], rowCount: Number(changes) };
	};

	const exec = (script: string): void => {
		db.exec(script);
	};

	/**
	 * Open a transaction, and answer whether `query_only` was turned on for it. That is
	 * the connection's setting, on for exactly this transaction's length: nothing else
	 * uses the connection meanwhile. A handle the host made query-only stays so.
	 */
	const begin = (readOnly: boolean): boolean => {
		// `Number`: a handle opened with `readBigInts` reads the pragma as `0n`.
		const restrict =
			readOnly && Number(prepare(db, "PRAGMA query_only").get()?.query_only) === 0;
		if (restrict) db.exec("PRAGMA query_only = ON");
		try {
			// A read-only one takes no write lock: another connection to the file keeps
			// writing, and its snapshot starts at its first statement.
			db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
		} catch (error) {
			if (restrict) db.exec("PRAGMA query_only = OFF");
			throw error;
		}
		return restrict;
	};

	/** Commit, or roll back and throw when the commit failed. */
	const commit = (): void => {
		try {
			db.exec("COMMIT");
		} catch (error) {
			rollback();
			throw error;
		}
	};

	/** Undo the open transaction, keeping whatever failure led here. */
	const rollback = (): void => {
		if (!db.isTransaction) return;
		try {
			db.exec("ROLLBACK");
		} catch {
			// A failed ROLLBACK is a symptom, not the cause.
		}
	};

	/** Close a transaction `begin` opened: `query_only` off again if it turned it on. */
	const end = (restrict: boolean): void => {
		if (restrict) db.exec("PRAGMA query_only = OFF");
	};

	const backend: SingleConnectionBackend = {
		dialect: "sqlite",
		adapter: "node:sqlite",
		run,
		exec,

		async transaction<T>(
			fn: (inner: Connection) => Promise<T>,
			readOnly: boolean,
		): Promise<T> {
			const restrict = begin(readOnly);
			try {
				let result: T;
				try {
					result = await fn(backend);
				} catch (error) {
					rollback();
					throw error;
				}
				commit();
				return result;
			} finally {
				end(restrict);
			}
		},

		classify: classifySqlite,

		close(): void {
			if (db.isOpen) db.close();
		},
	};

	const sync: SyncBackend = {
		run,
		exec,
		transaction<T>(fn: () => T, readOnly: boolean): T {
			const restrict = begin(readOnly);
			try {
				let result: T;
				try {
					result = fn();
				} catch (error) {
					rollback();
					throw error;
				}
				commit();
				return result;
			} finally {
				end(restrict);
			}
		},
	};

	return { backend, sync };
}
