/**
 * The migrate wiring (`./migrate`): `@marianmeres/migrate` over a `Driver`, so that one set
 * of versions runs on every adapter, inside the driver's own transactions and locks, and a
 * worker writes through the driver it already knows (fragments, typed errors and all).
 *
 * `createMigrate(db)` answers a `Migrate` instance whose four hooks are the driver's:
 *
 * | Hook               | `capabilities.crossProcessLock`              | otherwise                         |
 * | ------------------ | -------------------------------------------- | --------------------------------- |
 * | `wrapRun`          | `db.exclusive("migrate:<table>", run)`       | `db.transaction(run)`             |
 * | `wrapStep`         | `db.transaction(run)`                        | `db.transaction(run)`, joining it |
 * | `getActiveVersion` | the newest row; `null` while no table exists | same                              |
 * | `setActiveVersion` | one insert, under the run lock               | same                              |
 *
 * The version table is created inside the run lock, at the start of a run; a read never
 * creates it.
 *
 * **Where the lock crosses processes** (a Postgres pool or client), a run holds the
 * advisory lock and commits step by step: a failed step is undone with its version mark,
 * and the steps before it stay. **Everywhere else** the run is one transaction, because
 * there the transaction is the only lock another process honours: a failed step undoes the
 * whole run, the version table's creation included. (The package's own SQLite helper keeps
 * the earlier steps through a savepoint; this wiring has none.)
 *
 * **Interop with the package's own helpers.** The version table's DDL is theirs, character
 * for character per dialect, and the run lock is named `migrate:<table>`, which gives the
 * same advisory keys as the Postgres helper (the name's and the current schema's). A
 * database migrated by either can be continued by the other, and the two exclude each other
 * while running: on Postgres through the advisory lock, on SQLite through the write lock
 * both take for the length of a run.
 *
 * **Workers** receive `{ db, ...context }`. `db` is the driver itself: whatever a worker
 * issues through it from its own call runs inside the step's transaction, and is rolled back
 * with it. A worker must not open `BEGIN` / `COMMIT` / `ROLLBACK` itself, and cannot run a
 * statement that refuses a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) or that has
 * no effect inside one (SQLite's `PRAGMA foreign_keys`). A statement issued from a context
 * that is not the worker's (a callback registered before the run) is not in the step: on a
 * single connection it waits for the run that awaits it.
 *
 * **One active version is stored**, not a ledger of applied steps: `up()` runs the
 * registered versions above the active one. A version registered later _below_ the active
 * one is therefore never applied, and never reported as pending.
 *
 * Runtime-neutral: the driver does the I/O, and the package's core imports nothing from
 * `node:*`, so the wiring loads in a Worker as well as in Node.
 */

import { Migrate } from "@marianmeres/migrate";
import type { DialectName, Driver } from "../core/contract.ts";

/** The default name of the version table: the package's own helpers' default too. */
export const MIGRATE_TABLE = "__migrate__";

/** The context every worker receives, next to the extra properties of `options.context`. */
export interface MigrateContext {
	/** The driver. Inside a step, its statements are in the step's transaction. */
	db: Driver;
}

/** Options of {@link createMigrate}. */
export interface MigrateOptions<
	TExtra extends Record<string, unknown> = Record<never, never>,
> {
	/**
	 * The table the active version is kept in, created by the first run. Letters, digits
	 * and underscores only, and not starting with a digit. {@link MIGRATE_TABLE} by default.
	 */
	table?: string;
	/** Extra properties for the context every worker receives, next to `db`. */
	context?: TExtra;
	/** Optional logger for debugging purposes, handed to `Migrate` as it is. */
	logger?: (...args: unknown[]) => void;
}

/** The statements of the version table, one set per dialect. */
interface Statements {
	/** The table, when missing: the package's DDL, character for character. */
	readonly ensure: string;
	/** Whether the table exists, with its name as the one parameter. */
	readonly exists: string;
	/** The newest row's version. */
	readonly read: string;
	/** A new row, with the version (or `null`) as the one parameter. */
	readonly write: string;
}

/** The package's own statements, per dialect (its `pg.ts` and `sqlite.ts`). */
function statementsOf(dialect: DialectName, table: string): Statements {
	if (dialect === "pg") {
		return {
			ensure:
				`create table if not exists ${table} (` +
				`id bigint generated always as identity primary key, ` +
				`version text null, ` +
				`created_at timestamptz not null default now())`,
			exists: `select to_regclass($1) is not null as found`,
			read: `select version from ${table} order by id desc limit 1`,
			write: `insert into ${table} (version) values ($1)`,
		};
	}
	return {
		ensure:
			`CREATE TABLE IF NOT EXISTS ${table} (` +
			`id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`version TEXT NULL, ` +
			`created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
		exists: `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
		read: `SELECT version FROM ${table} ORDER BY id DESC LIMIT 1`,
		write: `INSERT INTO ${table} (version) VALUES (?)`,
	};
}

/**
 * A `Migrate` instance that keeps its active version in a table of `db`'s database and runs
 * every version through `db`: under one lock per run, and in one transaction per step.
 *
 * @param db - The driver; the caller keeps owning it, and closes it.
 * @param options - Table name, extra context, logger.
 * @returns A `Migrate` instance ready for `addVersion()`.
 * @throws {TypeError} If `db` is not a driver, or an option is not what it says, a table
 * name holding anything but letters, digits and underscores included.
 */
export function createMigrate<
	TExtra extends Record<string, unknown> = Record<never, never>,
>(db: Driver, options: MigrateOptions<TExtra> = {}): Migrate<TExtra & MigrateContext> {
	assertDriver(db);
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`createMigrate(db, options) takes an object, got ${describe(options)}`,
		);
	}
	// Only a missing name is the default: `null` is a mistake, not a request for it.
	const table: unknown = options.table === undefined ? MIGRATE_TABLE : options.table;
	// The name goes into SQL text: an identifier cannot be a bound parameter.
	if (typeof table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new TypeError(
			`Invalid table name ${describe(table)} (letters, digits and underscores only)`,
		);
	}
	const extra: unknown = options.context;
	if (
		extra !== undefined &&
		(typeof extra !== "object" || extra === null || Array.isArray(extra))
	) {
		throw new TypeError(
			`createMigrate: context is an object, got ${describe(extra)}`,
		);
	}
	const logger: unknown = options.logger;
	if (logger !== undefined && typeof logger !== "function") {
		throw new TypeError(
			`createMigrate: logger is a function, got ${describe(logger)}`,
		);
	}

	const statements = statementsOf(db.dialect, table);
	const lockName = `migrate:${table}`;
	const crossProcess = db.capabilities.crossProcessLock === true;

	/**
	 * Runs `fn` under the run lock, with the version table in place. Re-entrant, with no
	 * flag of its own: `exclusive` runs a caller that holds the name at once, and a nested
	 * `transaction` joins the open one, so a step's `setActiveVersion` is in its step.
	 */
	const locked = <T>(fn: () => Promise<T>): Promise<T> => {
		const body = async (): Promise<T> => {
			await db.query(statements.ensure);
			return fn();
		};
		return crossProcess ? db.exclusive(lockName, body) : db.transaction(body);
	};

	const exists = async (): Promise<boolean> => {
		const { rows } = await db.query<{ found: unknown }>(statements.exists, [table]);
		// Postgres answers one row holding a boolean; SQLite a row when the table exists.
		return db.dialect === "pg" ? rows[0]?.found === true : rows.length > 0;
	};

	const context = { ...options.context, db } as TExtra & MigrateContext;

	return new Migrate<TExtra & MigrateContext>(
		{
			getActiveVersion: async () => {
				// The table may not exist yet, and a read does not create it. Inside a run
				// it exists, and the check costs one statement.
				if (!(await exists())) return null;
				const { rows } = await db.query<{ version: unknown }>(statements.read);
				const version = rows[0]?.version;
				return typeof version === "string" ? version : null;
			},

			// Inside a run this is the step's own transaction. Outside one (a manual
			// `setActiveVersion()` or `forceSetActiveVersion()`) it takes the lock itself.
			setActiveVersion: async (version) => {
				await locked(() => db.query(statements.write, [version ?? null]));
			},

			wrapRun: (run) => locked(run),

			wrapStep: (run) => db.transaction(() => run()),

			logger: options.logger,
		},
		context,
	);
}

/** A driver, refused before anything starts when it is not shaped like one. */
function assertDriver(db: unknown): asserts db is Driver {
	const shaped =
		typeof db === "object" &&
		db !== null &&
		["query", "exec", "transaction", "exclusive"].every(
			(method) => typeof (db as Record<string, unknown>)[method] === "function",
		) &&
		((db as { dialect?: unknown }).dialect === "pg" ||
			(db as { dialect?: unknown }).dialect === "sqlite") &&
		typeof (db as { capabilities?: unknown }).capabilities === "object" &&
		(db as { capabilities?: unknown }).capabilities !== null;
	if (!shaped) {
		throw new TypeError("createMigrate(db) takes a sqlkit Driver");
	}
}

/** A short, safe description of a value for an error message. */
function describe(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "object") return "an object";
	return typeof value === "undefined" ? "undefined" : `a ${typeof value}`;
}
