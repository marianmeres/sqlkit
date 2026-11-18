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

	test("query() refuses a text of several statements, and names exec()", async () => {
		const fixture = await createPgFixture();
		try {
			const { driver } = fixture;
			// Without parameters node-postgres runs every statement of the text, so the
			// refusal comes after them: what it prevents is a garbled answer.
			await assert.rejects(
				driver.query(
					"create table t (id text); insert into t (id) values ('ran')",
				),
				typeError(/exec\(\)/),
			);
			assert.deepEqual((await driver.query("select id from t")).rows, [
				{ id: "ran" },
			]);
		} finally {
			await fixture.dispose();
		}
	});
});
