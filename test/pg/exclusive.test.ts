// `exclusive` on the pool adapter crosses processes (plan doc 02 #4). Ported from the
// `exclusive` cases of the prior implementation's concurrency suite
// (tmp/prior-art/engine/test/pg/sync-concurrency.test.ts), with a schema per case (D20).
//
// Adapter-specific by necessity: only Postgres has more than one process on a database,
// and only a pool has more than one connection to pin. The conformance body holds every
// adapter to `exclusive` inside one driver (R8); what only this database can show:
//
// - **Another pool is another process.** A second pool on the same schema waits for the
//   lock, including after a holder that rejected, and a pool on another schema does not,
//   since the lock is keyed by both.
// - **A pool of one** runs a section's statements, transactions and nested sections on its
//   one connection, rather than waiting for a second connection it will never get.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Driver } from "../../src/mod.ts";
import { createPgFixture, type PgFixture, sameSchema } from "./_fixture.ts";

/** A promise and the function that resolves it: a gate a case opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** One case, on a schema of its own, with a second pool on that schema beside it. */
async function withTwoPools(
	body: (fixture: PgFixture, other: Driver) => Promise<void>,
	otherMax = 4,
): Promise<void> {
	const fixture = await createPgFixture();
	const other = sameSchema(fixture.schema, otherMax);
	try {
		await body(fixture, other);
	} finally {
		try {
			await other.close();
		} finally {
			await fixture.dispose();
		}
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

describe("pg/exclusive", () => {
	test("two pools on one schema exclude each other", () =>
		withTwoPools(async ({ driver: one }, two) => {
			const seen: string[] = [];
			const holding = gate();
			const release = gate();
			const first = one.exclusive("lock", async () => {
				seen.push("one in");
				holding.open();
				await release.opened;
				seen.push("one out");
			});
			await holding.opened;
			const second = two.exclusive("lock", async () => {
				seen.push("two in");
			});
			// Long enough for a lock that did not exclude to have let `two` in: it polls
			// every 10 ms at first.
			await sleep(100);
			assert.deepEqual(seen, ["one in"]);
			release.open();
			await Promise.all([first, second]);
			assert.deepEqual(seen, ["one in", "one out", "two in"]);
		}));

	test("a holder that rejected releases the lock for another pool", () =>
		withTwoPools(async ({ driver: one }, two) => {
			const holding = gate();
			const fail = gate();
			const failed = new Error("the holder failed");
			const first = one.exclusive("lock", async () => {
				holding.open();
				await fail.opened;
				throw failed;
			});
			const refused = assert.rejects(first, (error) => error === failed);
			await holding.opened;
			let entered = false;
			const second = two.exclusive("lock", async () => {
				entered = true;
				return "second";
			});
			await sleep(100);
			assert.equal(entered, false, "the second pool did not wait for the holder");
			fail.open();
			await refused;
			assert.equal(await second, "second");
		}));

	test("two schemas do not wait for each other", () =>
		withTwoPools(async ({ driver: one }) => {
			const holding = gate();
			const release = gate();
			const held = one.exclusive("lock", async () => {
				holding.open();
				await release.opened;
			});
			await holding.opened;
			// Another schema is another deployment: the same name does not wait for it.
			let elsewhere: PgFixture | undefined;
			try {
				elsewhere = await createPgFixture();
				const answer = await Promise.race([
					elsewhere.driver.exclusive("lock", async () => "not kept waiting"),
					sleep(2_000).then(() => "kept waiting"),
				]);
				assert.equal(answer, "not kept waiting");
			} finally {
				release.open();
				await held;
				await elsewhere?.dispose();
			}
		}));

	test("a pool of one runs a section's statements and transactions on its client", () =>
		withTwoPools(async (_fixture, single) => {
			const pids = await single.exclusive("single", async (tx) => {
				const before = await backendPid(tx);
				const inTransaction = await tx.transaction(async (inner) => {
					await inner.exec("create table t (id text primary key)");
					await inner.query("insert into t (id) values ($1)", ["in-section"]);
					return backendPid(inner);
				});
				const nested = await tx.exclusive("single-other", (inner) =>
					backendPid(inner),
				);
				const reentered = await tx.exclusive("single", (inner) =>
					backendPid(inner),
				);
				const after = await backendPid(tx);
				return [before, inTransaction, nested, reentered, after];
			});
			assert.equal(new Set(pids).size, 1, `ran on ${pids.join(", ")}`);
			// The connection went back to the pool once the section ended.
			assert.equal(await backendPid(single), pids[0]);
			const { rows } = await single.query("select id from t");
			assert.deepEqual(rows, [{ id: "in-section" }]);
		}, 1));
});
