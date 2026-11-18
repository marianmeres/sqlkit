// The pool adapter's own surface (plan doc 02 #4): what `createPgDriver` refuses, what it
// declares, and `close()` (D13), which ends the pool it was given, once, and is refused
// where it would wait for itself.
//
// Adapter-specific, not a conformance body: each case is about the pool node-postgres
// gives (its `ended` flag, its checkouts) or the factory's options, which no other adapter
// has. The contract's rules are in test/conformance/driver.ts.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import pg from "pg";
import { SqlError } from "../../src/mod.ts";
import { createPgDriver, type PgPoolLike } from "../../src/pg/mod.ts";
import { testPgConfig } from "../_env.ts";
import { createPgFixture } from "./_fixture.ts";

/** An error that is a `TypeError`, whose message matches `pattern`. */
function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

describe("pg/adapter: createPgDriver", () => {
	test("refuses what is not a pool, and a schema that is not a non-empty string", async () => {
		for (const notAPool of [undefined, null, {}, { connect() {} }, "pool"]) {
			assert.throws(
				() => createPgDriver(notAPool as unknown as PgPoolLike),
				typeError(/takes a node-postgres pg\.Pool/),
			);
		}
		// Nothing connects: the factory is refused before it touches the pool.
		const pool = new pg.Pool(testPgConfig());
		try {
			for (const schema of ["", 42, null]) {
				assert.throws(
					() => createPgDriver(pool, { schema: schema as unknown as string }),
					typeError(/schema is a non-empty string/),
				);
			}
			assert.throws(
				() => createPgDriver(pool, "s" as unknown as { schema: string }),
				typeError(/takes an object/),
			);
			assert.throws(() => createPgDriver(pool, { schema: "a\0b" }), TypeError);
		} finally {
			await pool.end();
		}
	});

	test("declares a pool: concurrent writers, a cross-process lock, no sync tier", async () => {
		const pool = new pg.Pool(testPgConfig());
		const driver = createPgDriver(pool);
		try {
			assert.equal(driver.dialect, "pg");
			assert.equal(driver.adapter, "pg");
			assert.deepEqual(driver.capabilities, {
				sync: false,
				concurrentWriters: true,
				crossProcessLock: true,
			});
			assert.ok(Object.isFrozen(driver.capabilities));
			assert.equal(driver.sync, undefined);
		} finally {
			await driver.close();
		}
	});

	test("close() ends the pool it was given, once", async () => {
		const pool = new pg.Pool(testPgConfig());
		const driver = createPgDriver(pool);
		assert.deepEqual((await driver.query("select 1 as one")).rows, [{ one: 1 }]);
		const first = driver.close();
		assert.equal(driver.close(), first, "a second close() started another end()");
		await first;
		assert.equal(pool.ended, true);
		await driver.close();
		await assert.rejects(driver.query("select 1"));
	});

	test("close() inside a transaction or a section is refused; the work goes on", async () => {
		const fixture = await createPgFixture();
		try {
			const { driver } = fixture;
			await driver.query("create table t (id text primary key)");
			await driver.transaction(async (tx) => {
				await assert.rejects(
					tx.close(),
					typeError(/cannot be called inside a transaction/),
				);
				await tx.query("insert into t (id) values ('after-refused-close')");
			});
			await driver.exclusive("lock", async (tx) => {
				await assert.rejects(tx.close(), typeError(/exclusive section/));
			});
			const { rows } = await driver.query("select id from t");
			assert.deepEqual(rows, [{ id: "after-refused-close" }]);
		} finally {
			await fixture.dispose();
		}
	});

	test("query() sends on the extended protocol: the server refuses several statements", async () => {
		const fixture = await createPgFixture();
		try {
			const { driver } = fixture;
			await driver.exec("create table t (id text)");
			// Without `queryMode` node-postgres would send a parameterless text as a simple
			// query, and run both inserts.
			await assert.rejects(
				driver.query(
					"insert into t (id) values ('one'); insert into t (id) values ('two')",
				),
				(error) =>
					error instanceof SqlError &&
					error.kind === "unknown" &&
					error.code === "42601" &&
					/multiple commands/.test(error.message),
			);
			assert.deepEqual((await driver.query("select id from t")).rows, []);
			// What the extended protocol takes, a statement that refuses a transaction too.
			await driver.query("create index concurrently t_id on t (id)");
		} finally {
			await fixture.dispose();
		}
	});

	test("query() on a node-postgres that ignores queryMode refuses after, naming exec()", async () => {
		// A simple query answers one result per statement, which only a node-postgres that
		// predates `queryMode` would send for a text with no values.
		const result = { rows: [], rowCount: 1, command: "INSERT" };
		const pool: PgPoolLike = {
			connect: () =>
				Promise.resolve({
					query: () => Promise.resolve([result, result] as never),
					release: () => {},
				}),
			end: () => Promise.resolve(),
			on: () => undefined,
			listenerCount: () => 1,
		};
		await assert.rejects(
			createPgDriver(pool).query(
				"insert into t values (1); insert into t values (2)",
			),
			typeError(
				/held several \(each of them ran\): a script goes through exec\(\)/,
			),
		);
	});
});
