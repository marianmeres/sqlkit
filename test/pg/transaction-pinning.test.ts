// The pool adapter pins a transaction to one connection (plan doc 02 #4). Ported from the
// prior implementation's suite of the same name
// (tmp/prior-art/engine/test/pg/transaction-pinning.test.ts), with a schema per case (D20).
//
// Adapter-specific by necessity: only Postgres has a pool, and only Postgres can be asked
// which backend ran a statement (`pg_backend_pid()`). The two properties under test, that
// a transaction's statements all land on one pinned connection and that the `schema`
// option governs every checkout, have no counterpart on a single connection. Nor do the
// last two: only Postgres aborts a transaction on a failed statement and then answers its
// `COMMIT` with `ROLLBACK`, and only a pool emits `error` for an idle client.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import pg from "pg";
import { type Driver, TransactionAbortedError } from "../../src/mod.ts";
import { createPgDriver } from "../../src/pg/mod.ts";
import { testPgConfig } from "../_env.ts";
import { createPgFixture, type PgFixture } from "./_fixture.ts";

/** Well over the pool size, so several transactions must share the three backends. */
const BLOCKS = 20;
const POOL_MAX = 3;

/** One case, on a schema of its own holding an empty table `t`, with a pool of three. */
async function withFixture(body: (fixture: PgFixture) => Promise<void>): Promise<void> {
	const fixture = await createPgFixture({ max: POOL_MAX });
	try {
		await fixture.driver.query("create table t (id text primary key)");
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

/** Which backend ran this statement, as seen through a given driver handle. */
async function backendPid(handle: Driver): Promise<number> {
	const { rows } = await handle.query<{ pid: number }>(
		"select pg_backend_pid() as pid",
	);
	const pid = rows[0]?.pid;
	assert.ok(typeof pid === "number", "pg_backend_pid() returned nothing");
	return pid;
}

/** Rows of `t` whose id is `like` the pattern. `count(*)` is text on Postgres. */
async function countRows(driver: Driver, like: string): Promise<number> {
	const { rows } = await driver.query<{ c: string }>(
		"select count(*) as c from t where id like $1",
		[like],
	);
	return Number(rows[0]?.c ?? -1);
}

describe("pg/transaction-pinning", () => {
	test("the schema option governs every checkout, not just the first", () =>
		withFixture(async ({ driver, schema }) => {
			// Enough parallel statements to involve every backend in the pool.
			const seen = await Promise.all(
				Array.from({ length: POOL_MAX * 3 }, async () => {
					const { rows } = await driver.query<{ s: string }>(
						"select current_schema() as s",
					);
					return rows[0]?.s;
				}),
			);
			assert.deepEqual(
				seen,
				Array.from(seen, () => schema),
			);

			// And an unqualified CREATE TABLE landed there, nowhere else. Its name is this
			// case's own: every other case has a table `t` in a schema of its own.
			const table = `${schema}_landed`;
			await driver.query(`create table ${table} (id text)`);
			const { rows } = await driver.query<{ table_schema: string }>(
				"select table_schema from information_schema.tables where table_name = $1",
				[table],
			);
			assert.deepEqual(
				rows.map((row) => row.table_schema),
				[schema],
			);
		}));

	test("every statement of a transaction runs on one backend", () =>
		withFixture(async ({ driver }) => {
			const blocks = Array.from({ length: BLOCKS }, (_, i) =>
				driver.transaction(async (tx) => {
					const onTx = await backendPid(tx);
					await tx.query("insert into t (id) values ($1)", [`row-${i}`]);
					// The outer handle, not `tx`: AsyncLocalStorage must route it to the
					// pinned client rather than check out a second one.
					const onOuterHandle = await backendPid(driver);
					// A nested transaction joins the open one: with a pool of three and
					// twenty parallel blocks, checking out a second client would deadlock.
					const onNested = await tx.transaction(backendPid);
					await tx.exec(`insert into t (id) values ('exec-${i}')`);
					return [onTx, onOuterHandle, onNested];
				}),
			);
			const pids = await Promise.all(blocks);

			for (const [onTx, onOuterHandle, onNested] of pids) {
				assert.equal(
					onOuterHandle,
					onTx,
					"a bare query() left the pinned client",
				);
				assert.equal(
					onNested,
					onTx,
					"a nested transaction left the pinned client",
				);
			}
			// Which makes the equality above meaningful: the blocks did not all happen to
			// run on one backend. Three is the ceiling the pool size sets.
			const distinct = new Set(pids.map(([pid]) => pid));
			assert.ok(
				distinct.size >= 2 && distinct.size <= POOL_MAX,
				`expected 2..${POOL_MAX} distinct backends, saw ${distinct.size}`,
			);
			assert.equal(await countRows(driver, "row-%"), BLOCKS);
			assert.equal(await countRows(driver, "exec-%"), BLOCKS);
		}));

	test("a thrown error rolls back and the connection goes back usable", () =>
		withFixture(async ({ driver }) => {
			await assert.rejects(
				driver.transaction(async (tx) => {
					await tx.query("insert into t (id) values ($1)", ["undone-1"]);
					assert.equal(
						await countRows(tx, "undone-%"),
						1,
						"the write is visible inside its own transaction",
					);
					throw new Error("boom");
				}),
				/boom/,
			);
			assert.equal(await countRows(driver, "undone-%"), 0);

			// The client was released after ROLLBACK, not left mid-transaction: every
			// connection of the pool takes a transaction of its own and commits it.
			await Promise.all(
				Array.from({ length: POOL_MAX }, (_, i) =>
					driver.transaction(async (tx) => {
						await tx.query("insert into t (id) values ($1)", [
							`undone-ok-${i}`,
						]);
					}),
				),
			);
			assert.equal(await countRows(driver, "undone-%"), POOL_MAX);
		}));

	test("a COMMIT the server answered with ROLLBACK rejects", () =>
		withFixture(async ({ driver }) => {
			// The callback swallows a failed statement and returns normally. Postgres has
			// aborted the transaction by then, so its COMMIT commits nothing, and says so
			// only through the command tag.
			await assert.rejects(
				driver.transaction(async (tx) => {
					await tx.query("insert into t (id) values ($1)", ["aborted-1"]);
					await assert.rejects(tx.query("select * from no_such_table"));
				}),
				(error) =>
					error instanceof TransactionAbortedError &&
					/answered COMMIT with ROLLBACK/.test(error.message),
			);
			assert.equal(await countRows(driver, "aborted-%"), 0);

			// The server ended that transaction itself; the connection went back usable.
			await Promise.all(
				Array.from({ length: POOL_MAX }, (_, i) =>
					driver.transaction(async (tx) => {
						await tx.query("insert into t (id) values ($1)", [
							`aborted-ok-${i}`,
						]);
					}),
				),
			);
			assert.equal(await countRows(driver, "aborted-ok-%"), POOL_MAX);
		}));

	test("a pool nobody listens to gets an error listener, and a warning", async () => {
		// Nothing connects: neither pool is ever asked for a client here.
		const alone = new pg.Pool(testPgConfig());
		assert.equal(alone.listenerCount("error"), 0);
		const quiet = createPgDriver(alone);
		const heard: Error[] = [];
		const hosted = new pg.Pool(testPgConfig());
		hosted.on("error", (error) => heard.push(error));
		const loud = createPgDriver(hosted);
		try {
			assert.equal(alone.listenerCount("error"), 1);
			// An unlistened `error` would throw from `emit`, and from a pool end the
			// process. The driver's listener turns it into a warning instead.
			const warned = once(process, "warning");
			alone.emit("error", new Error("idle client lost"));
			const [warning] = (await warned) as [Error];
			assert.match(
				warning.message,
				/idle pooled connection failed.*idle client lost/,
			);
			assert.equal((warning.cause as Error).message, "idle client lost");

			// When the host listens, the error is the host's to report: no warning.
			let warnings = 0;
			const count = (): void => {
				warnings += 1;
			};
			process.on("warning", count);
			try {
				hosted.emit("error", new Error("host's to handle"));
				await new Promise((resolve) => setImmediate(resolve));
				await new Promise((resolve) => setImmediate(resolve));
			} finally {
				process.off("warning", count);
			}
			assert.deepEqual(
				heard.map((error) => error.message),
				["host's to handle"],
			);
			assert.equal(warnings, 0);
		} finally {
			await quiet.close();
			await loud.close();
		}
	});
});
