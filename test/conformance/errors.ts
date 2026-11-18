// The `errors` conformance body: typed errors end to end (plan doc 01 #4, D07, D17), raised
// by real failures on every registered adapter. The classifiers' unit tests read
// fabricated shapes; this body holds each adapter to wrapping what its database really
// throws, at every place it can throw: a statement, a script, a read-only transaction's
// write, and the `COMMIT` that checks a deferred constraint.
//
// What each database reports about a constraint differs, and the cases say so per dialect:
// the expectations are the field table of plan doc 01 #3, exactly. A field the table does
// not promise for a dialect is asserted absent, so a field that starts to appear is a
// change the table has to record.
//
// Runner-agnostic: no `node:test` here, so the same cases run inside workerd. Every case
// creates and disposes a database of its own.

import assert from "node:assert/strict";
import {
	CheckViolationError,
	classifyPg,
	classifySqlite,
	type DialectName,
	type Driver,
	ForeignKeyViolationError,
	NotNullViolationError,
	ReadOnlyError,
	SqlError,
	type SqlErrorInfo,
	type SqlErrorKind,
	type SyncDriver,
	sql,
	UniqueViolationError,
} from "../../src/mod.ts";
import type { AdapterCase, Suite } from "./_suite.ts";

/**
 * The schema every case starts from. Portable: the same text runs on both dialects. Every
 * constraint the cases violate is named, but for the unnamed check, and the deferred
 * foreign key is checked only at `COMMIT`.
 */
const SCHEMA = `
create table parent (id integer primary key);
create table item (
	id text primary key,
	code text constraint item_code_unique unique,
	email text,
	name text not null,
	qty integer constraint qty_positive check (qty > 0),
	n integer check (n > 0),
	parent_id integer constraint item_parent_fk references parent (id)
);
create unique index item_email_lower on item (lower(email));
create table deferred_child (
	id integer primary key,
	parent_id integer constraint deferred_child_parent_fk references parent (id)
		deferrable initially deferred
);
insert into parent (id) values (1);
insert into item (id, code, email, name) values ('a', 'taken', 'Taken@Example.com', 'a');
`;

/** What a case expects of a `SqlError`, on each dialect. */
type Fields = Pick<SqlErrorInfo, "code" | "constraint" | "table" | "columns">;
type PerDialect = Readonly<Record<DialectName, Fields>>;

/** The class of a kind, as `toSqlError` picks it. */
type ErrorClass = abstract new (...args: never[]) => SqlError;

/** The classifier of a dialect: what read `cause`, if `cause` is the driver's error. */
const CLASSIFIERS: Readonly<Record<DialectName, (error: unknown) => SqlErrorInfo>> = {
	pg: classifyPg,
	sqlite: classifySqlite,
};

/** What `promise` rejected with; a fulfilment fails the case. */
async function rejection(what: string, promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail(`${what} was not refused`),
		(error: unknown) => error,
	);
}

/** What `call` threw; a return fails the case. */
function thrown(what: string, call: () => unknown): unknown {
	try {
		call();
	} catch (error) {
		return error;
	}
	return assert.fail(`${what} was not refused`);
}

/**
 * `error` is a `SqlError` of `Class` and `kind`, from `dialect`, carrying exactly `fields`,
 * with the driver's own error as `cause`: an error that is not a `SqlError`, whose message
 * is the message, and that the dialect's classifier reads as this very error.
 */
function assertSqlError(
	error: unknown,
	Class: ErrorClass,
	kind: SqlErrorKind,
	dialect: DialectName,
	fields: Fields,
): asserts error is SqlError {
	assert.ok(
		error instanceof Class,
		`expected a ${Class.name}, got ${String(error)} (${(error as Error)?.name})`,
	);
	assert.ok(error instanceof SqlError);
	assert.equal(error.kind, kind);
	assert.equal(error.dialect, dialect);
	assert.deepEqual(
		{
			code: error.code,
			constraint: error.constraint,
			table: error.table,
			columns: error.columns === undefined ? undefined : [...error.columns],
		},
		{
			code: fields.code,
			constraint: fields.constraint,
			table: fields.table,
			columns: fields.columns === undefined ? undefined : [...fields.columns],
		},
	);
	const cause: unknown = error.cause;
	assert.ok(cause instanceof Error, "cause is not the driver's error");
	assert.ok(
		!(cause instanceof SqlError),
		"cause is a SqlError, not the driver's error",
	);
	assert.equal(error.message, cause.message, "the message is not the driver's");
	const read = CLASSIFIERS[dialect](cause);
	assert.deepEqual(
		{ ...read, columns: read.columns === undefined ? undefined : [...read.columns] },
		{
			kind,
			...fields,
			columns: fields.columns === undefined ? undefined : [...fields.columns],
		},
		"the classifier reads cause as another error",
	);
}

/** The fields for the dialect a driver speaks, from a per-dialect table. */
function expected(db: Pick<Driver, "dialect">, table: PerDialect): Fields {
	return table[db.dialect];
}

/** Drop the keys left undefined, so a table entry can be written as the database reports. */
function only(fields: Fields): Fields {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Fields;
}

/** A duplicate primary key: Postgres names the index, SQLite the column. */
const PRIMARY_KEY: PerDialect = {
	pg: only({ code: "23505", constraint: "item_pkey", table: "item" }),
	sqlite: only({ code: "1555", table: "item", columns: ["id"] }),
};

/** A duplicate of a named unique column constraint: SQLite names the column, not it. */
const UNIQUE_COLUMN: PerDialect = {
	pg: only({ code: "23505", constraint: "item_code_unique", table: "item" }),
	sqlite: only({ code: "2067", table: "item", columns: ["code"] }),
};

/** A duplicate in a unique index on an expression: SQLite names the index, and no table. */
const UNIQUE_EXPRESSION: PerDialect = {
	pg: only({ code: "23505", constraint: "item_email_lower", table: "item" }),
	sqlite: only({ code: "2067", constraint: "item_email_lower" }),
};

/** A reference to no row: SQLite names nothing at all. */
const FOREIGN_KEY: PerDialect = {
	pg: only({ code: "23503", constraint: "item_parent_fk", table: "item" }),
	sqlite: only({ code: "787" }),
};

/** The deferred reference, refused by `COMMIT`. */
const DEFERRED_FOREIGN_KEY: PerDialect = {
	pg: only({
		code: "23503",
		constraint: "deferred_child_parent_fk",
		table: "deferred_child",
	}),
	sqlite: only({ code: "787" }),
};

/** `NULL` in a `NOT NULL` column: Postgres names no constraint (D26.1). */
const NOT_NULL: PerDialect = {
	pg: only({ code: "23502", table: "item", columns: ["name"] }),
	sqlite: only({ code: "1299", table: "item", columns: ["name"] }),
};

/** A named check: SQLite names it, and no table. */
const CHECK_NAMED: PerDialect = {
	pg: only({ code: "23514", constraint: "qty_positive", table: "item" }),
	sqlite: only({ code: "275", constraint: "qty_positive" }),
};

/** An unnamed check: Postgres names the one it generated; SQLite reports the expression. */
const CHECK_UNNAMED: PerDialect = {
	pg: only({ code: "23514", constraint: "item_n_check", table: "item" }),
	sqlite: only({ code: "275" }),
};

/** A write in a read-only transaction. */
const READ_ONLY: PerDialect = {
	pg: only({ code: "25006" }),
	sqlite: only({ code: "8" }),
};

/** A statement on a table that is not there: no kind of its own, so `unknown`. */
const NO_SUCH_TABLE: PerDialect = {
	pg: only({ code: "42P01" }),
	sqlite: only({ code: "1" }),
};

/** Rows of a table, as a number: `count(*)` is text on Postgres. */
async function count(db: Driver, table: string): Promise<number> {
	const { rows } = await db.query<{ c: number | string }>(
		`select count(*) as c from ${table}`,
	);
	return Number(rows[0]?.c ?? -1);
}

/** The same, synchronously. */
function countSync(tier: SyncDriver, table: string): number {
	const { rows } = tier.query<{ c: number | string }>(
		`select count(*) as c from ${table}`,
	);
	return Number(rows[0]?.c ?? -1);
}

/**
 * Errors a callback may throw, each of which must come out as it was thrown. The second is
 * shaped like a driver's error on both dialects, so a wrapper that classified it would make
 * it a `UniqueViolationError`.
 */
function callbackErrors(): unknown[] {
	return [
		new Error("the callback's own"),
		Object.assign(new Error("duplicate key value violates unique constraint"), {
			code: "23505",
			errcode: 2067,
		}),
		"a string",
		undefined,
	];
}

export function errorsContract(suite: Suite, adapter: AdapterCase): void {
	/** One case, on a database of its own holding the schema above. */
	const test = (name: string, body: (db: Driver) => Promise<void>): void => {
		suite.test(name, async () => {
			const fixture = await adapter.create();
			try {
				await fixture.driver.exec(SCHEMA);
				await body(fixture.driver);
			} finally {
				await fixture.dispose();
			}
		});
	};

	// ── constraint violations ───────────────────────────────────────────────────────

	test("errors: a duplicate is a UniqueViolationError, with the fields the dialect reports", async (db) => {
		const cases: [string, PerDialect, string][] = [
			[
				"a primary key",
				PRIMARY_KEY,
				"insert into item (id, name) values ('a', 'again')",
			],
			[
				"a unique column",
				UNIQUE_COLUMN,
				"insert into item (id, code, name) values ('b', 'taken', 'b')",
			],
			[
				"an expression index",
				UNIQUE_EXPRESSION,
				"insert into item (id, email, name) values ('b', 'taken@example.COM', 'b')",
			],
		];
		for (const [what, fields, statement] of cases) {
			const error = await rejection(what, db.query(statement));
			assertSqlError(error, UniqueViolationError, "unique", db.dialect, {
				...expected(db, fields),
			});
			assert.equal(error.retryable, false);
			assert.equal(error.name, "UniqueViolationError");
		}
		assert.equal(await count(db, "item"), 1);
	});

	test("errors: a missing reference is a ForeignKeyViolationError", async (db) => {
		const error = await rejection(
			"a missing parent",
			db.query(
				sql`insert into item (id, name, parent_id) values (${"b"}, ${"b"}, ${99})`,
			),
		);
		assertSqlError(
			error,
			ForeignKeyViolationError,
			"foreign_key",
			db.dialect,
			expected(db, FOREIGN_KEY),
		);
		assert.equal(error.retryable, false);
	});

	test("errors: a NULL in a NOT NULL column is a NotNullViolationError", async (db) => {
		const error = await rejection(
			"a null name",
			db.query(sql`insert into item (id, name) values (${"b"}, ${null})`),
		);
		assertSqlError(
			error,
			NotNullViolationError,
			"not_null",
			db.dialect,
			expected(db, NOT_NULL),
		);
		assert.equal(error.retryable, false);
	});

	test("errors: a row a CHECK refused is a CheckViolationError, named or not", async (db) => {
		const named = await rejection(
			"a named check",
			db.query(sql`insert into item (id, name, qty) values (${"b"}, ${"b"}, ${0})`),
		);
		assertSqlError(
			named,
			CheckViolationError,
			"check",
			db.dialect,
			expected(db, CHECK_NAMED),
		);
		const unnamed = await rejection(
			"an unnamed check",
			db.query(sql`insert into item (id, name, n) values (${"b"}, ${"b"}, ${0})`),
		);
		assertSqlError(
			unnamed,
			CheckViolationError,
			"check",
			db.dialect,
			expected(db, CHECK_UNNAMED),
		);
		assert.equal(unnamed.retryable, false);
	});

	test("errors: a refusal with no kind of its own is a SqlError of kind unknown", async (db) => {
		const error = await rejection(
			"a missing table",
			db.query("select * from no_such_table"),
		);
		assertSqlError(
			error,
			SqlError,
			"unknown",
			db.dialect,
			expected(db, NO_SUCH_TABLE),
		);
		assert.equal(Object.getPrototypeOf(error), SqlError.prototype);
		assert.equal(error.retryable, false);
	});

	// ── every place a driver throws ─────────────────────────────────────────────────

	test("errors: exec() and a transaction's statements are typed the same way", async (db) => {
		const fromExec = await rejection(
			"exec",
			db.exec("insert into item (id, name) values ('a', 'again')"),
		);
		assertSqlError(
			fromExec,
			UniqueViolationError,
			"unique",
			db.dialect,
			expected(db, PRIMARY_KEY),
		);

		// The statement rejects inside the transaction, and the callback lets it go: the
		// transaction rejects with that same error, not a second wrapping of it.
		let inside: unknown;
		const outcome = await rejection(
			"transaction",
			db.transaction(async (tx) => {
				try {
					await tx.query("insert into item (id, name) values ('a', 'again')");
				} catch (error) {
					inside = error;
					throw error;
				}
			}),
		);
		assertSqlError(
			inside,
			UniqueViolationError,
			"unique",
			db.dialect,
			expected(db, PRIMARY_KEY),
		);
		assert.equal(outcome, inside, "the transaction rejected with another error");
	});

	test("errors: a constraint COMMIT checks rejects the transaction, typed; nothing is kept", async (db) => {
		const error = await rejection(
			"a deferred reference",
			db.transaction(async (tx) => {
				await tx.query(
					"insert into deferred_child (id, parent_id) values (1, 99)",
				);
				await tx.query("insert into parent (id) values (2)");
			}),
		);
		assertSqlError(
			error,
			ForeignKeyViolationError,
			"foreign_key",
			db.dialect,
			expected(db, DEFERRED_FOREIGN_KEY),
		);
		assert.equal(await count(db, "deferred_child"), 0);
		assert.equal(await count(db, "parent"), 1, "the failed COMMIT kept a write");
		// The connection is out of the transaction: the next one commits.
		await db.transaction(async (tx) => {
			await tx.query("insert into deferred_child (id, parent_id) values (1, 1)");
		});
		assert.equal(await count(db, "deferred_child"), 1);
	});

	test("errors: a write in a read-only transaction is a ReadOnlyError", async (db) => {
		let inside: unknown;
		const outcome = await rejection(
			"a read-only transaction's write",
			db.transaction(
				async (tx) => {
					try {
						await tx.query("insert into parent (id) values (2)");
					} catch (error) {
						inside = error;
						throw error;
					}
				},
				{ readOnly: true },
			),
		);
		assertSqlError(
			inside,
			ReadOnlyError,
			"read_only",
			db.dialect,
			expected(db, READ_ONLY),
		);
		assert.equal(inside.retryable, false);
		assert.equal(outcome, inside);
		assert.equal(await count(db, "parent"), 1);
	});

	// ── what is never wrapped ───────────────────────────────────────────────────────

	test("errors: what a callback throws comes out as it was thrown, never wrapped", async (db) => {
		for (const error of callbackErrors()) {
			const what = String(error);
			assert.equal(
				await rejection(
					`transaction (${what})`,
					db.transaction(async () => {
						throw error;
					}),
				),
				error,
			);
			assert.equal(
				await rejection(
					`a transaction after a write (${what})`,
					db.transaction(async (tx) => {
						await tx.query("insert into parent (id) values (2)");
						throw error;
					}),
				),
				error,
			);
			assert.equal(
				await rejection(
					`a nested transaction (${what})`,
					db.transaction((tx) =>
						tx.transaction(async () => {
							throw error;
						}),
					),
				),
				error,
			);
			assert.equal(
				await rejection(
					`exclusive (${what})`,
					db.exclusive("errors", async () => {
						throw error;
					}),
				),
				error,
			);
			assert.equal(
				await rejection(
					`exclusive inside a transaction (${what})`,
					db.transaction((tx) =>
						tx.exclusive("errors", async () => {
							throw error;
						}),
					),
				),
				error,
			);
			assert.equal(
				await rejection(
					`a transaction inside exclusive (${what})`,
					db.exclusive("errors", (tx) =>
						tx.transaction(async () => {
							throw error;
						}),
					),
				),
				error,
			);
		}
		// Every one of them rolled back.
		assert.equal(await count(db, "parent"), 1);
	});

	test("errors: a refused call is a TypeError, never a SqlError", async (db) => {
		const refusals: [string, () => Promise<unknown>][] = [
			["query(42)", () => db.query(42 as unknown as string)],
			["exec(undefined)", () => db.exec(undefined as unknown as string)],
			["a Map as a parameter", () => db.query(sql`select ${new Map()} as m`)],
			["transaction(null)", () => db.transaction(null as never)],
			["exclusive with no callback", () => db.exclusive("errors", "fn" as never)],
		];
		for (const [what, call] of refusals) {
			const error = await rejection(what, call());
			assert.ok(error instanceof TypeError, `${what}: ${String(error)}`);
			assert.ok(!(error instanceof SqlError), `${what} is a SqlError`);
		}
	});

	// ── the sync tier ───────────────────────────────────────────────────────────────

	if (adapter.sync) {
		/** A sync-tier case: the same database, through `driver.sync`. */
		const syncTest = (
			name: string,
			body: (tier: SyncDriver, db: Driver) => void | Promise<void>,
		): void => {
			test(name, async (db) => {
				const tier = db.sync;
				assert.ok(
					tier !== undefined,
					"the adapter is marked as having a sync tier",
				);
				await body(tier, db);
			});
		};

		syncTest(
			"errors: the sync tier throws the same typed errors, at the call",
			(tier) => {
				const fromQuery = thrown("sync.query", () =>
					tier.query("insert into item (id, name) values ('a', 'again')"),
				);
				assertSqlError(
					fromQuery,
					UniqueViolationError,
					"unique",
					tier.dialect,
					expected(tier, PRIMARY_KEY),
				);
				const fromExec = thrown("sync.exec", () =>
					tier.exec("insert into item (id, name, qty) values ('b', 'b', 0)"),
				);
				assertSqlError(
					fromExec,
					CheckViolationError,
					"check",
					tier.dialect,
					expected(tier, CHECK_NAMED),
				);
				let inside: unknown;
				const outcome = thrown("a read-only sync transaction's write", () =>
					tier.transaction(
						(tx) => {
							try {
								tx.query("insert into parent (id) values (2)");
							} catch (error) {
								inside = error;
								throw error;
							}
						},
						{ readOnly: true },
					),
				);
				assertSqlError(
					inside,
					ReadOnlyError,
					"read_only",
					tier.dialect,
					expected(tier, READ_ONLY),
				);
				assert.equal(outcome, inside);
				assert.equal(countSync(tier, "parent"), 1);
			},
		);

		syncTest(
			"errors: a constraint a sync COMMIT checks throws, typed; nothing is kept",
			(tier) => {
				const error = thrown("a deferred reference", () =>
					tier.transaction((tx) => {
						tx.query(
							"insert into deferred_child (id, parent_id) values (1, 99)",
						);
						tx.query("insert into parent (id) values (2)");
					}),
				);
				assertSqlError(
					error,
					ForeignKeyViolationError,
					"foreign_key",
					tier.dialect,
					expected(tier, DEFERRED_FOREIGN_KEY),
				);
				assert.equal(countSync(tier, "deferred_child"), 0);
				assert.equal(countSync(tier, "parent"), 1);
				tier.transaction((tx) => {
					tx.query("insert into deferred_child (id, parent_id) values (1, 1)");
				});
				assert.equal(countSync(tier, "deferred_child"), 1);
			},
		);

		syncTest(
			"errors: what a sync callback throws comes out as it was thrown",
			(tier) => {
				for (const error of callbackErrors()) {
					const what = String(error);
					assert.equal(
						thrown(`sync.transaction (${what})`, () =>
							tier.transaction((tx) => {
								tx.query("insert into parent (id) values (2)");
								throw error;
							}),
						),
						error,
					);
					assert.equal(
						thrown(`a nested sync.transaction (${what})`, () =>
							tier.transaction((tx) =>
								tx.transaction(() => {
									throw error;
								}),
							),
						),
						error,
					);
				}
				assert.equal(countSync(tier, "parent"), 1);
				// A refusal of the tier's own is a TypeError, never a SqlError.
				const refused = thrown("an async callback", () =>
					tier.transaction(async () => undefined),
				);
				assert.ok(refused instanceof TypeError);
				assert.ok(!(refused instanceof SqlError));
			},
		);
	}
}
