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
 * `query()` runs one statement. node:sqlite would compile a text's first statement and
 * drop the rest without a word, so a text holding more is refused with a `TypeError`
 * before any of it runs; `exec()` is for a script.
 *
 * **Statements can be kept.** A query or a data change (a text that opens with `select`,
 * `insert`, `update`, `delete`, `replace`, `with` or `values`) is then compiled once and
 * run again whenever the same text comes back, which it does: a `sql` fragment renders to
 * the same text whatever its values. The driver keeps `statementCache` of them and drops
 * the least recently used. Any other text (a pragma, DDL) and every script is compiled
 * per call, and empties the cache: see `run`.
 *
 * A kept statement is not compiled again, so what SQLite reads only while compiling it is
 * read once. SQLite recompiles one itself, on its next run, when the schema or a setting
 * it was compiled under has changed, or an authorizer was installed, or a function
 * replaced. It does not when an authorizer answers differently than it did, a session
 * starts recording, a function of another arity or a virtual-table module is registered,
 * or a limit is lowered. All of that is done on the handle, behind the driver.
 *
 * node:sqlite before Node 24.20 and 26.6 misreads the columns of a statement SQLite
 * recompiled, which is why the package's `engines` start there. `engines` only warns, so
 * the runtime is asked (`rereadsColumns`), and on one that misreads nothing is kept.
 *
 * Two entry points:
 *
 * - `createSqliteDriver(db, options)` takes a database the host opened and sets nothing on
 *   it: its busy timeout, journal mode and foreign keys are as the host opened it.
 *   `close()` closes it. The host keeps the handle, and can change behind the driver what
 *   a statement compiles to, so no statement is kept unless `statementCache` asks.
 * - `openSqlite(path, options)` opens one with the conventional settings (a busy timeout,
 *   WAL for a file) and makes a driver over it that keeps 128 statements: nobody else has
 *   the handle.
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

/** How many statements the driver over a database `openSqlite` opened keeps, by default. */
const STATEMENT_CACHE_DEFAULT = 128;

/** How a driver over a node:sqlite database works. */
export interface SqliteDriverOptions {
	/**
	 * How many compiled statements the driver keeps to run again, by their text: queries
	 * and data changes only. A whole number from 0, and 0 keeps none, so every call
	 * compiles. Past the number the least recently used one is dropped.
	 *
	 * 128 by default in `openSqlite`. 0 by default in `createSqliteDriver`: what SQLite
	 * reads only while it compiles a statement, a kept one read once, and a host that
	 * keeps the handle can change it behind the driver (an authorizer that answers
	 * differently, a session opened, a function of another arity or a virtual-table
	 * module registered, a limit lowered). A host that does none of that after the
	 * driver's first statement asks for a number.
	 *
	 * Nothing is kept, whatever the number, on a Node older than the package's `engines`
	 * allow (before 24.20, any 25, before 26.6): node:sqlite there misreads the columns
	 * of a statement SQLite recompiled after a schema change.
	 */
	statementCache?: number;
}

/** How `openSqlite` opens a database, and how the driver over it works. */
export interface OpenSqliteOptions extends SqliteDriverOptions {
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
 *
 * No compiled statement is kept unless `options.statementCache` asks: see
 * `SqliteDriverOptions`. Those kept are the driver's own; nothing the host prepares on the
 * handle is touched.
 */
export function createSqliteDriver(
	db: DatabaseSync,
	options?: SqliteDriverOptions,
): Driver {
	if (
		typeof db !== "object" ||
		db === null ||
		typeof (db as { prepare?: unknown }).prepare !== "function" ||
		typeof (db as { exec?: unknown }).exec !== "function"
	) {
		throw new TypeError("createSqliteDriver(db) takes a node:sqlite DatabaseSync");
	}
	return driverOver(
		db,
		wholeNumberOf(
			options?.statementCache,
			0,
			"createSqliteDriver: statementCache",
			"statements",
		),
	);
}

/**
 * Opens a database with the conventional settings and answers a driver over it: a busy
 * timeout (`options.busyTimeout`, 5000 ms by default) and, for a file, the WAL journal,
 * which lets readers on other connections read while one writes. `path` is `":memory:"`
 * by default. The driver keeps up to `options.statementCache` compiled statements, 128 by
 * default: the database is the driver's alone.
 *
 * A file that cannot be opened, or a journal that cannot be switched, throws a `SqlError`
 * with node:sqlite's error as `cause`; a path that is not one is a `TypeError`, and so
 * is an option out of its range, before anything is opened.
 */
export function openSqlite(path = ":memory:", options?: OpenSqliteOptions): Driver {
	const timeout = wholeNumberOf(
		options?.busyTimeout,
		BUSY_TIMEOUT_DEFAULT_MS,
		"openSqlite: busyTimeout",
		"milliseconds",
	);
	const statementCache = wholeNumberOf(
		options?.statementCache,
		STATEMENT_CACHE_DEFAULT,
		"openSqlite: statementCache",
		"statements",
	);
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(path, { timeout });
	} catch (error) {
		throw wrap(error);
	}
	try {
		// `location()` is null for a database that is not a file.
		if (db.location() !== null) db.exec("PRAGMA journal_mode = WAL");
		return driverOver(db, statementCache);
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

/** A driver over `db`, keeping up to `statementCache` compiled statements. */
function driverOver(db: DatabaseSync, statementCache: number): Driver {
	const { backend, sync } = sqliteBackends(db, statementCache);
	return createSingleConnectionDriver(backend, sync);
}

/**
 * An option that counts something: `fallback` when it is not given, else a whole number
 * of `unit` from 0, or a `TypeError` naming the `option`.
 */
function wholeNumberOf(
	value: unknown,
	fallback: number,
	option: string,
	unit: string,
): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(
			`${option} is a whole number of ${unit} from 0, got ${
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

/**
 * Where in `text`, from `from` on, something that is not a blank, a `;` or a comment
 * starts; `text.length` when nothing does. Only those may follow the one statement a
 * `query()` runs, and a statement's first word comes after them. A linear scan, not a
 * regular expression: a run of dashes would make one backtrack exponentially.
 */
function afterTrivia(text: string, from: number): number {
	let i = from;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		// `;`, space, tab, newline, vertical tab, form feed, carriage return.
		if (c === 59 || c === 32 || (c >= 9 && c <= 13)) {
			i++;
		} else if (text.startsWith("--", i)) {
			const end = text.indexOf("\n", i + 2);
			if (end === -1) return text.length;
			i = end + 1;
		} else if (text.startsWith("/*", i)) {
			// SQLite reads an unterminated block comment to the end of the text.
			const end = text.indexOf("*/", i + 2);
			if (end === -1) return text.length;
			i = end + 2;
		} else {
			return i;
		}
	}
	return text.length;
}

/**
 * The first word of a query or of a data change: the statements a driver keeps. An app
 * repeats them, and SQLite recompiles one when the schema changed under it.
 *
 * A list of what is kept, not of what is left out: a text it misjudges is compiled per
 * call, as every text was before, and empties the cache as any text off the list does.
 * A pragma is left out on purpose, since it may take effect while it is compiled; DDL
 * and the rest run once.
 */
const KEPT = new Set([
	"select",
	"insert",
	"update",
	"delete",
	"replace",
	"with",
	"values",
]);

/** Whether `text` is a statement a driver keeps: its first word is one of `KEPT`. */
function isKept(text: string): boolean {
	const start = afterTrivia(text, 0);
	let end = start;
	while (end < text.length && isLetter(text.charCodeAt(end))) end++;
	return KEPT.has(text.slice(start, end).toLowerCase());
}

/** An ASCII letter, of either case. */
function isLetter(code: number): boolean {
	return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

/** One statement, compiled: what a driver runs, and keeps. */
interface Compiled {
	readonly statement: StatementSync;
	/**
	 * Whether it returns columns, so its rows are read; else its changes are counted. By
	 * what the statement returns, not by a keyword: a write with `RETURNING` has columns,
	 * a plain one has none. Read when it is compiled, and true of a kept one for as long
	 * as it is kept: only a pragma changes it, and a pragma empties the cache.
	 */
	readonly returnsRows: boolean;
	/**
	 * True while it runs. A function the host registered on the handle may send the same
	 * text again from inside the running statement, and one statement cannot run twice at
	 * once: that call compiles its own.
	 */
	running: boolean;
}

/** The statements a driver keeps, by their text. */
interface StatementCache {
	/** The statement kept for `text`, which makes it the most recently used. */
	get(text: string): Compiled | undefined;
	/**
	 * Keep `compiled` for `text`, which has none kept: the least recently used one is
	 * dropped when the cache is full.
	 */
	set(text: string, compiled: Compiled): void;
	/** Keep none. */
	clear(): void;
}

/**
 * A cache of at most `limit` statements, which is 1 or more. A `Map` iterates in the
 * order its keys went in: one taken out and put back is the newest, and the first is the
 * least recently used. A statement dropped is finalized when it is collected, as every
 * statement compiled per call is.
 */
function createStatementCache(limit: number): StatementCache {
	const kept = new Map<string, Compiled>();
	return {
		get(text: string): Compiled | undefined {
			const compiled = kept.get(text);
			if (compiled !== undefined) {
				kept.delete(text);
				kept.set(text, compiled);
			}
			return compiled;
		},
		set(text: string, compiled: Compiled): void {
			if (kept.size >= limit) {
				const oldest = kept.keys().next().value;
				if (oldest !== undefined) kept.delete(oldest);
			}
			kept.set(text, compiled);
		},
		clear(): void {
			kept.clear();
		},
	};
}

/**
 * Whether the handle that compiled `statement` was closed since: node:sqlite finalizes a
 * handle's statements with it, and a finalized one throws whatever is asked of it.
 */
function isFinalized(statement: StatementSync): boolean {
	try {
		return typeof statement.sourceSQL !== "string";
	} catch {
		return true;
	}
}

/** What `rereadsColumns` found, once it has looked. */
let rereads: boolean | undefined;

/**
 * Whether this runtime's node:sqlite reads the columns of a statement SQLite recompiled.
 *
 * SQLite recompiles a statement on its next run when the schema is no longer the one it
 * was compiled under. node:sqlite before Node 24.20 and 26.6 counted the statement's
 * columns before that run: the first rows of a `select *` after an `ALTER TABLE` came
 * back with the columns the table had before, or as an error when it had lost one. A
 * statement compiled for the call meets that only when another connection changed the
 * schema. A kept one would meet it after every change its own connection made, so on such
 * a runtime nothing is kept.
 *
 * Asked of the runtime, not read from its version: once, on a database of its own. A
 * runtime that cannot answer keeps nothing.
 */
function rereadsColumns(): boolean {
	if (rereads !== undefined) return rereads;
	rereads = false;
	try {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("create table t (a); insert into t (a) values (1)");
			const kept = db.prepare("select * from t");
			kept.all();
			db.exec("alter table t add column b");
			rereads = Object.keys(kept.all()[0] ?? {}).length === 2;
		} finally {
			db.close();
		}
	} catch {
		// Not kept, then.
	}
	return rereads;
}

/** node:sqlite hands back rows without a prototype; the contract's rows are plain. */
function plainRow(row: Record<string, unknown>): Row {
	return { ...row };
}

/**
 * One node:sqlite handle as a single-connection backend, and as its sync tier's. Both
 * tiers run a statement the same way, so they share the up to `statementCache` statements
 * kept.
 */
function sqliteBackends(
	db: DatabaseSync,
	statementCache: number,
): {
	backend: SingleConnectionBackend;
	sync: SyncBackend;
} {
	const statements =
		statementCache > 0 && rereadsColumns()
			? createStatementCache(statementCache)
			: undefined;

	/** Compile `text`, which is to hold one statement. */
	const compile = (text: string): Compiled => {
		const statement = prepare(db, text);
		// node:sqlite compiles a text's first statement and ignores the rest, silently.
		if (afterTrivia(text, statement.sourceSQL.length) < text.length) {
			throw new TypeError(
				"query() runs one statement, and this text holds more (none of it ran): " +
					"a script goes through exec()",
			);
		}
		return { statement, returnsRows: statement.columns().length > 0, running: false };
	};

	const execute = (compiled: Compiled, values: SQLInputValue[]): QueryResult<Row> => {
		compiled.running = true;
		try {
			if (compiled.returnsRows) {
				const rows = compiled.statement.all(...values).map(plainRow);
				return { rows, rowCount: rows.length };
			}
			const { changes } = compiled.statement.run(...values);
			return { rows: [], rowCount: Number(changes) };
		} finally {
			compiled.running = false;
		}
	};

	/**
	 * `work`, which is not a kept statement, and after it no statement is kept, whether it
	 * failed or not: part of it may have run.
	 *
	 * It may have changed what a kept statement compiles to, in a way SQLite does not
	 * recompile for. A table made in `main` stands in front of one of that name in an
	 * attached database, which is the one an unqualified name meant until then; a pragma
	 * can change what a statement returns. So whatever was kept is compiled again.
	 */
	const emptying = <T>(work: () => T): T => {
		try {
			return work();
		} finally {
			statements?.clear();
		}
	};

	const run = (text: string, params: readonly unknown[]): QueryResult<Row> => {
		// The core bound every value by the parameter rule: each is one SQLite takes.
		const values = params as SQLInputValue[];
		if (statements === undefined) return execute(compile(text), values);
		let kept = statements.get(text);
		// One that is running was sent again from inside itself: see `Compiled.running`.
		if (kept !== undefined && !kept.running) {
			try {
				return execute(kept, values);
			} catch (error) {
				if (!isFinalized(kept.statement)) throw error;
				// The handle was closed under the driver, and every statement it had
				// compiled went with it: this one did not run. Whether the handle is
				// open again is for a compile to say.
				statements.clear();
				kept = undefined;
			}
		}
		// Compiled inside: a pragma may take effect while it is compiled.
		if (!isKept(text)) return emptying(() => execute(compile(text), values));
		const compiled = compile(text);
		// Kept before it runs: a statement that fails on its values is still a statement.
		if (kept === undefined) statements.set(text, compiled);
		return execute(compiled, values);
	};

	const exec = (script: string): void => emptying(() => db.exec(script));

	/**
	 * Open a transaction, and answer whether `query_only` was turned on for it. That is
	 * the connection's setting, on for exactly this transaction's length: nothing else
	 * uses the connection meanwhile. A handle the host made query-only stays so.
	 */
	const begin = (readOnly: boolean): boolean => {
		// `Number`: a handle opened with `readBigInts` reads the pragma as `0n`. It and
		// the statements of a transaction go to the handle as they are, not through
		// `exec`: none of them changes what a kept statement compiles to.
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
