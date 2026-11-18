// The PGlite adapter's own surface (plan doc 02 #6): a PGlite instance as a single-connection
// backend, an in-memory database per case.
//
// Adapter-specific by necessity. The conformance bodies hold `pglite` to the contract like
// every other adapter; what only PGlite can show:
//
// - **Its errors.** PGlite's reference does not describe its error objects, so the four
//   constraint violations are raised for real here and their `cause` is held to the shape
//   `classifyPg` reads: the SQLSTATE in `code`, and the constraint, table and column the
//   server reported.
// - **Its transaction.** PGlite runs `BEGIN` and `COMMIT` itself. A callback that swallowed
//   a failed statement is refused by the core before PGlite sends a `COMMIT`: the
//   rejection carries the failed statement's error, not PGlite's own "rolled back instead
//   of committed", and the instance takes the next transaction. A read-only transaction's
//   first statement is the one that makes it read-only, and the callback's rejection wins
//   over a `ROLLBACK` that failed after it.
// - **Its values.** An `int8` reads as a number while it is a safe integer and as a
//   `bigint` beyond: PGlite's parser, not node-postgres's text.
// - **The factory.** What it refuses, what it declares, and `close()` (D13).
//
// Suite names start with `pglite/`: `pnpm run test:pglite` selects them by it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	CheckViolationError,
	type Driver,
	ForeignKeyViolationError,
	NotNullViolationError,
	SqlError,
	sql,
	TransactionAbortedError,
	UniqueViolationError,
} from "../../src/mod.ts";
import {
	createPgliteDriver,
	type PgliteLike,
	type PgliteTransactionLike,
} from "../../src/pglite/mod.ts";
import { createPgliteFixture, freshPglite, type PgliteFixture } from "./_fixture.ts";

/** What `promise` rejected with; a fulfilment fails the case. */
async function rejection(what: string, promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail(`${what} was not refused`),
		(error: unknown) => error,
	);
}

/** An error that is a `TypeError`, whose message matches `pattern`. */
function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

/** One case, on an in-memory database of its own holding the tables below. */
async function withFixture(
	body: (fixture: PgliteFixture) => Promise<void>,
): Promise<void> {
	const fixture = await createPgliteFixture();
	try {
		await fixture.driver.exec(`
			create table parent (id integer primary key);
			create table item (
				id text constraint item_pkey primary key,
				name text not null,
				qty integer constraint qty_positive check (qty > 0),
				parent_id integer constraint item_parent_fk references parent (id)
			);
			insert into parent (id) values (1);
			insert into item (id, name) values ('a', 'a');
		`);
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

async function itemCount(driver: Driver): Promise<number> {
	const { rows } = await driver.query<{ c: unknown }>("select count(*) as c from item");
	return Number(rows[0]?.c);
}

/**
 * `error` is a `SqlError` of `Class`, with `code` and `fields`, whose `cause` is PGlite's
 * own error carrying the same: the shape `classifyPg` reads.
 */
function assertPgliteError(
	error: unknown,
	Class: abstract new (...args: never[]) => SqlError,
	code: string,
	fields: { constraint?: string; table?: string; columns?: string[] },
): void {
	assert.ok(error instanceof Class, `expected a ${Class.name}, got ${String(error)}`);
	assert.equal(error.dialect, "pg");
	assert.equal(error.code, code);
	assert.equal(error.constraint, fields.constraint);
	assert.equal(error.table, fields.table);
	assert.deepEqual(error.columns, fields.columns);
	const cause = error.cause as Record<string, unknown> | undefined;
	assert.ok(cause instanceof Error, `cause is ${String(cause)}`);
	assert.equal(cause.code, code);
	assert.equal(cause.constraint, fields.constraint);
	assert.equal(cause.table, fields.table);
	assert.equal(cause.column, fields.columns?.[0]);
	assert.equal(error.message, cause.message);
}

describe("pglite/errors", () => {
	test("the four constraint violations, raised for real, carry PGlite's SQLSTATE and fields", async () => {
		await withFixture(async ({ driver }) => {
			assertPgliteError(
				await rejection(
					"a duplicate",
					driver.query(
						sql`insert into item (id, name) values (${"a"}, ${"b"})`,
					),
				),
				UniqueViolationError,
				"23505",
				{ constraint: "item_pkey", table: "item" },
			);
			assertPgliteError(
				await rejection(
					"a missing parent",
					driver.query(
						sql`insert into item (id, name, parent_id) values (${"b"}, ${"b"}, ${9})`,
					),
				),
				ForeignKeyViolationError,
				"23503",
				{ constraint: "item_parent_fk", table: "item" },
			);
			// Postgres names the column of a not-null violation, and no constraint.
			assertPgliteError(
				await rejection(
					"a NULL name",
					driver.query(
						sql`insert into item (id, name) values (${"c"}, ${null})`,
					),
				),
				NotNullViolationError,
				"23502",
				{ table: "item", columns: ["name"] },
			);
			assertPgliteError(
				await rejection(
					"a quantity below one",
					driver.query(
						sql`insert into item (id, name, qty) values (${"d"}, ${"d"}, ${0})`,
					),
				),
				CheckViolationError,
				"23514",
				{ constraint: "qty_positive", table: "item" },
			);
			assert.equal(await itemCount(driver), 1);
		});
	});

	test("a callback that swallowed a failed statement rejects with TransactionAbortedError; nothing is committed", async () => {
		await withFixture(async ({ driver, pglite }) => {
			const error = await rejection(
				"the aborted transaction",
				driver.transaction(async (tx) => {
					await tx.query(
						sql`insert into item (id, name) values (${"kept"}, ${"k"})`,
					);
					await assert.rejects(
						tx.query(
							sql`insert into item (id, name) values (${"a"}, ${"dup"})`,
						),
						UniqueViolationError,
					);
					return "swallowed";
				}),
			);
			assert.ok(
				error instanceof TransactionAbortedError,
				`expected a TransactionAbortedError, got ${String(error)}`,
			);
			assert.equal(error.kind, "aborted");
			assert.equal(error.dialect, "pg");
			// The core refused before PGlite sent a COMMIT: had it sent one, the rejection
			// would be PGlite's own "rolled back instead of committed" (25P02).
			const cause = error.cause as { code?: unknown } | undefined;
			assert.equal(cause?.code, "23505");
			assert.equal(await itemCount(driver), 1);
			// PGlite rolled back: the instance is out of the transaction, through the
			// driver and directly.
			await driver.transaction(async (tx) => {
				await tx.query(
					sql`insert into item (id, name) values (${"after"}, ${"x"})`,
				);
			});
			assert.equal(await itemCount(driver), 2);
			const { rows } = await pglite.query<{ n: number }>("select 1 as n");
			assert.deepEqual(rows, [{ n: 1 }]);
		});
	});
});

describe("pglite/adapter", () => {
	test("createPgliteDriver refuses what is not shaped like a PGlite instance", () => {
		const loose = createPgliteDriver as (db: unknown) => Driver;
		for (const db of [undefined, null, "memory://", {}, { query() {}, exec() {} }]) {
			assert.throws(() => loose(db), typeError(/takes a PGlite instance/));
		}
	});

	test("it declares a pg dialect, its name, and one connection with no sync tier", async () => {
		const fixture = await createPgliteFixture();
		try {
			const { driver } = fixture;
			assert.equal(driver.dialect, "pg");
			assert.equal(driver.adapter, "pglite");
			assert.deepEqual(driver.capabilities, {
				sync: false,
				concurrentWriters: false,
				crossProcessLock: false,
			});
			assert.equal(driver.sync, undefined);
		} finally {
			await fixture.dispose();
		}
	});

	test("close() closes the instance it was given (D13), once", async () => {
		const pglite = await freshPglite();
		const driver = createPgliteDriver(pglite);
		await driver.query("select 1");
		assert.equal(pglite.closed, false);
		await Promise.all([driver.close(), driver.close()]);
		assert.equal(pglite.closed, true);
		await assert.rejects(driver.query("select 1"), SqlError);
	});

	test("a read-only transaction makes itself read-only with its first statement", async () => {
		const pglite = await freshPglite();
		const sent: string[] = [];
		const recorded = (target: PgliteTransactionLike): PgliteTransactionLike => ({
			query(text, params) {
				sent.push(`query: ${text}`);
				return target.query(text, params);
			},
			exec(text) {
				sent.push(`exec: ${text}`);
				return target.exec(text);
			},
		});
		const db: PgliteLike = {
			...recorded(pglite),
			transaction: (callback) => pglite.transaction((tx) => callback(recorded(tx))),
			close: () => pglite.close(),
		};
		const driver = createPgliteDriver(db);
		try {
			await driver.transaction((tx) => tx.query("select 1 as one"), {
				readOnly: true,
			});
			await driver.transaction((tx) => tx.query("select 2 as two"));
			assert.deepEqual(sent, [
				"exec: set transaction isolation level repeatable read, read only",
				"query: select 1 as one",
				"query: select 2 as two",
			]);
		} finally {
			await driver.close();
		}
	});

	test("the callback's rejection wins over a ROLLBACK that failed after it", async () => {
		// PGlite answers with the ROLLBACK's failure when that fails too; this stand-in
		// does so on purpose.
		const rollbackFailed = new Error("rollback failed: the instance is gone");
		const db: PgliteLike = {
			query: async () => ({ rows: [], fields: [] }),
			exec: async () => [],
			async transaction(callback) {
				try {
					return await callback({
						query: async () => ({ rows: [], fields: [] }),
						exec: async () => [],
					});
				} catch {
					throw rollbackFailed;
				}
			},
			close: async () => undefined,
		};
		const driver = createPgliteDriver(db);
		const boom = new Error("boom");
		await assert.rejects(
			driver.transaction(async () => {
				throw boom;
			}),
			(error) => error === boom,
		);
	});

	test("an int8 reads as a number while it is a safe integer, and as a bigint beyond", async () => {
		const fixture = await createPgliteFixture();
		try {
			const { rows } = await fixture.driver.query(
				"select cast(42 as int8) as small, cast(9007199254740993 as int8) as big",
			);
			assert.deepEqual(rows, [{ small: 42, big: 9007199254740993n }]);
		} finally {
			await fixture.dispose();
		}
	});
});
