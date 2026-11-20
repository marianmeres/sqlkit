/**
 * The Durable Objects adapter (`./do`): a `Driver` over the SQLite storage of a Durable
 * Object, `ctx.storage`, or anything shaped like it (`DoStorageLike`).
 *
 * A Durable Object's database is one connection, so this is a backend of the
 * single-connection driver core, as node:sqlite, one `pg.Client` and PGlite are:
 * everything takes its turn, and a statement runs inside the open transaction only when
 * that transaction's own callback issued it. `sql.exec` is synchronous, so the driver has
 * a sync tier too (`driver.sync`). Capabilities: `{ sync: true, concurrentWriters: false,
 * crossProcessLock: false }`. The dialect is `sqlite`.
 *
 * **It requires the `nodejs_compat` compatibility flag** (D24): the core carries a
 * transaction in `AsyncLocalStorage`, from `node:async_hooks`. Nothing else of Node is
 * used.
 *
 * What workerd does differently from node:sqlite, and what the adapter does about it (the
 * findings `Fnn` are in the plan set's `DO-FINDINGS.md`):
 *
 * - **Transactions are callbacks** (F04): `sql.exec` refuses `BEGIN`, `SAVEPOINT`,
 *   `COMMIT` and `ROLLBACK`. The async tier's transaction is `storage.transaction`, the
 *   sync tier's `storage.transactionSync`. A script given to `exec`, a migration's
 *   included, cannot hold a transaction statement of its own.
 * - **A savepoint is a transaction inside the open one** (F07, F08, F16): workerd nests
 *   `storage.transaction` and `storage.transactionSync`, either inside either, and undoes
 *   the inner one alone when its closure throws. `savepoint` is that, on each tier.
 * - **An open async transaction holds the whole object** (F14): workerd lets no other
 *   request in until it settles, even while it awaits a timer or a `fetch`. So an async
 *   transaction must not await external I/O: do the I/O first, then open it.
 * - **`query()` cannot refuse a text of several statements** (F01): `sql.exec` runs every
 *   statement of a text given no values, and has no way to refuse one before it runs.
 *   R11 does not hold here: pass one statement to `query()`, and a script to `exec()`.
 * - **Read-only is enforced by detection** (F12, D34.7): `PRAGMA query_only` is not
 *   authorized. Inside a read-only transaction, on either tier, a statement that wrote
 *   (its cursor reports `rowsWritten`, or `total_changes()` moved) throws a
 *   `ReadOnlyError` with SQLite's own code for it, `8` (`SQLITE_READONLY`), as node:sqlite's
 *   `query_only` does. The transaction remembers it and throws it again once its callback
 *   has returned, still inside `storage.transaction` or `transactionSync`, so the write is
 *   rolled back even when the callback caught the first one. A read reports no rows
 *   written, sorts and groupings included (checked on workerd 1.20260730.1). The one write
 *   it cannot see is DDL that is not the last statement of a text, which neither counter
 *   reports.
 * - **A deferred constraint is not checked by `transaction()`** (F15): workerd checks one
 *   (`deferrable initially deferred`) when the request's own implicit transaction ends, and
 *   a violation then resets the object to its last good state, failing the request. Keep
 *   every foreign key immediate on Durable Objects.
 * - **Values** (F09): the parameter rule runs first, as on every adapter. After it a
 *   `bigint` in the safe-integer range is bound as a number, since workerd binds no
 *   `bigint`; any other is a `TypeError`. An integer column reads back as a number, so one
 *   beyond 2^53 loses precision.
 * - **Rows**: a blob comes back from workerd as an `ArrayBuffer`; the adapter hands it on
 *   as a `Uint8Array` over the same bytes (R10). `rowCount` is the number of rows for a
 *   statement that returns columns, and `changes()`, read right after it, otherwise (F10).
 * - **Errors** (F11): workerd's carry no code, only a message ending in SQLite's code
 *   names, which `classifySqlite` reads. The core wraps them, as on every adapter (D07).
 *
 * `close()` leaves the storage as it is (it belongs to the object) and ends the driver:
 * every call after it fails with a `SqlError`, as on a closed node:sqlite handle.
 *
 * Nothing is imported from workerd: the shape the adapter takes is declared structurally,
 * so the package has no Cloudflare dependency, and its types do not collide with Node's.
 */

import { classifySqlite } from "../core/classify-sqlite.ts";
import type { Driver, QueryResult, Row } from "../core/contract.ts";
import type {
	Connection,
	SingleConnectionBackend,
	SyncBackend,
} from "../single/backend.ts";
import { createSingleConnectionDriver } from "../single/driver.ts";

/** What `sql.exec` answers: the statement has run, its rows are read on demand. */
export interface DoSqlCursorLike {
	/** Every row, as plain objects. */
	toArray(): Record<string, unknown>[];
	/** The columns of the rows: none for a statement that returns none. */
	readonly columnNames: readonly string[];
	/** Rows the statement wrote, the index entries and the catalog included. */
	readonly rowsWritten: number;
}

/** `ctx.storage.sql`, as the adapter uses it. */
export interface DoSqlStorageLike {
	/** Run a text, with its values bound to the placeholders of its last statement. */
	exec(query: string, ...bindings: unknown[]): DoSqlCursorLike;
}

/** A SQLite-backed Durable Object's `ctx.storage`. Only what the adapter calls is declared. */
export interface DoStorageLike {
	readonly sql: DoSqlStorageLike;
	/** Commits when `closure` returns, rolls back when it throws. */
	transactionSync<T>(closure: () => T): T;
	/** Commits when `closure` resolves, rolls back when it rejects. */
	transaction<T>(closure: () => Promise<T>): Promise<T>;
}

/** SQLite's result code for a write the database refused as read-only. */
const SQLITE_READONLY = 8;

/**
 * A driver over a SQLite-backed Durable Object's storage: `createDoDriver(ctx.storage)`.
 * `driver.sync` is the same storage, synchronously. `close()` ends the driver and leaves
 * the storage as it is.
 */
export function createDoDriver(storage: DoStorageLike): Driver {
	assertStorage(storage);
	const { backend, sync } = doBackends(storage);
	return createSingleConnectionDriver(backend, sync);
}

/** A read-only transaction in progress: what it saw when it began, and what it refused. */
interface ReadOnlyWatch {
	/** `total_changes()` when the transaction began, or when a savepoint took a write back. */
	baseline: number;
	/** The refusal of the first write it saw, thrown again when the callback returns. */
	refused: Error | undefined;
}

/** One Durable Object's storage as a single-connection backend, and as its sync tier's. */
function doBackends(storage: DoStorageLike): {
	backend: SingleConnectionBackend;
	sync: SyncBackend;
} {
	const { sql } = storage;
	let closed = false;
	/** The read-only transaction open on the storage; none outside one. */
	let watch: ReadOnlyWatch | undefined;

	const assertOpen = (): void => {
		if (closed) {
			throw new Error(
				"the Durable Objects driver is closed: close() was called on it",
			);
		}
	};

	/** The rows the connection has changed since it opened: SQLite's `total_changes()`. */
	const totalChanges = (): number =>
		Number(sql.exec("select total_changes() as n").toArray()[0]?.n);

	/**
	 * Inside a read-only transaction, refuse a statement that wrote. `rowsWritten` is the
	 * last statement of a text, DDL included; `total_changes()` is every row an `INSERT`,
	 * `UPDATE` or `DELETE` of the text changed. The write has happened: the refusal is
	 * remembered, so the transaction rolls back however the callback handles it.
	 */
	const refuseWrite = (cursor: DoSqlCursorLike): void => {
		if (watch === undefined) return;
		if (cursor.rowsWritten === 0 && totalChanges() === watch.baseline) return;
		const refused = Object.assign(
			new Error(
				"attempt to write a readonly database: a statement wrote inside a read-only " +
					"transaction, which is rolled back",
			),
			{ errcode: SQLITE_READONLY },
		);
		watch.refused ??= refused;
		throw refused;
	};

	const run = (text: string, params: readonly unknown[]): QueryResult<Row> => {
		assertOpen();
		const cursor = sql.exec(text, ...params.map(bindable));
		refuseWrite(cursor);
		// Rows or a count by what the statement returns, not by a keyword: a write with
		// `RETURNING` has columns, a plain one has none.
		if (cursor.columnNames.length > 0) {
			const rows = cursor.toArray().map(plainRow);
			return { rows, rowCount: rows.length };
		}
		// The statement has run to its end (F10), and nothing runs between two
		// synchronous calls, so this is its count.
		const changes = sql.exec("select changes() as n").toArray()[0]?.n;
		return { rows: [], rowCount: Number(changes) };
	};

	const exec = (script: string): void => {
		assertOpen();
		refuseWrite(sql.exec(script));
	};

	/** Watch a transaction about to begin, when it is read-only. */
	const begin = (readOnly: boolean): void => {
		watch = readOnly ? { baseline: totalChanges(), refused: undefined } : undefined;
	};

	/** Throw the write a read-only transaction refused, once its callback is done. */
	const settle = (): void => {
		if (watch?.refused !== undefined) throw watch.refused;
	};

	/**
	 * A savepoint was undone, in a read-only transaction that had refused `before` when
	 * the savepoint opened. A write refused inside it went with it, so the transaction is
	 * as it was: it remembers what it did then, and counts changes from here, since
	 * `total_changes()` keeps what a rollback took back.
	 */
	const forget = (before: Error | undefined): void => {
		if (watch === undefined || watch.refused === before) return;
		watch.refused = before;
		watch.baseline = totalChanges();
	};

	const backend: SingleConnectionBackend = {
		dialect: "sqlite",
		adapter: "durable-objects",
		run,
		exec,

		async transaction<T>(
			fn: (inner: Connection) => Promise<T>,
			readOnly: boolean,
		): Promise<T> {
			assertOpen();
			/** What `fn` rejected with, boxed, so that even a rejected `undefined` counts. */
			let failed: { error: unknown } | undefined;
			try {
				return await storage.transaction(async () => {
					begin(readOnly);
					let result: T;
					try {
						result = await fn(backend);
					} catch (error) {
						failed = { error };
						throw error;
					}
					settle();
					return result;
				});
			} catch (error) {
				// The callback's own rejection, as it was, whatever workerd rethrew.
				throw failed === undefined ? error : failed.error;
			} finally {
				watch = undefined;
			}
		},

		async savepoint<T>(fn: () => Promise<T>): Promise<T> {
			assertOpen();
			const refused = watch?.refused;
			/** What `fn` rejected with, boxed, so that even a rejected `undefined` counts. */
			let failed: { error: unknown } | undefined;
			try {
				// Inside the open transaction this is a savepoint of it (F08). The
				// read-only watch is the open transaction's, and goes on.
				return await storage.transaction(async () => {
					try {
						return await fn();
					} catch (error) {
						failed = { error };
						throw error;
					}
				});
			} catch (error) {
				forget(refused);
				// The callback's own rejection, as it was, whatever workerd rethrew.
				throw failed === undefined ? error : failed.error;
			}
		},

		classify: classifySqlite,

		close(): void {
			closed = true;
		},
	};

	const sync: SyncBackend = {
		run,
		exec,
		transaction<T>(fn: () => T, readOnly: boolean): T {
			assertOpen();
			try {
				return storage.transactionSync(() => {
					begin(readOnly);
					const result = fn();
					settle();
					return result;
				});
			} finally {
				watch = undefined;
			}
		},
		savepoint<T>(fn: () => T): T {
			assertOpen();
			const refused = watch?.refused;
			try {
				// Inside the open transaction, whichever tier opened it, this is a
				// savepoint of it (F07, F16).
				return storage.transactionSync(fn);
			} catch (error) {
				forget(refused);
				throw error;
			}
		},
	};

	return { backend, sync };
}

/**
 * A value bound by the parameter rule, as workerd binds it. Every one is already `null`, a
 * number, a string, a `Uint8Array` or a `bigint`; workerd refuses every `bigint` (F09), so
 * one in the safe-integer range goes as the number it equals, and any other is refused
 * rather than rounded.
 */
function bindable(value: unknown): unknown {
	if (typeof value !== "bigint") return value;
	const number = Number(value);
	if (!Number.isSafeInteger(number)) {
		throw new TypeError(
			"cannot bind a bigint outside the safe-integer range on Durable Objects: workerd " +
				"binds no bigint, so the adapter binds one as a number, and this one would " +
				"lose precision",
		);
	}
	return number;
}

/** A row as the contract has it: a plain object, a blob as a `Uint8Array` (R10). */
function plainRow(row: Record<string, unknown>): Row {
	const out: Row = {};
	for (const [column, value] of Object.entries(row)) {
		out[column] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
	}
	return out;
}

/** Durable Object storage, refused before anything starts when it is not shaped like it. */
function assertStorage(storage: unknown): asserts storage is DoStorageLike {
	const fields = storage as Record<string, unknown> | null;
	const sql = fields?.sql as Record<string, unknown> | null | undefined;
	const shaped =
		typeof storage === "object" &&
		storage !== null &&
		typeof fields?.transaction === "function" &&
		typeof fields?.transactionSync === "function" &&
		typeof sql === "object" &&
		sql !== null &&
		typeof sql.exec === "function";
	if (!shaped) {
		throw new TypeError(
			"createDoDriver(storage) takes a SQLite-backed Durable Object's ctx.storage",
		);
	}
}
