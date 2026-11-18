// The migrate wiring across processes on Postgres (plan doc 03 #2, D18): two drivers on two
// pools, as two processes deploying at once, calling `up()` together apply each version
// exactly once. The run lock is `exclusive("migrate:<table>")`, an advisory lock keyed by
// the name and the schema.
//
// Adapter-specific by necessity: only Postgres has more than one process on a database here.
// The conformance body (test/conformance/migrate.ts) holds every adapter to two instances on
// one driver; what only this database can show is two pools, and a run of one schema not
// waiting for a run of another.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createMigrate } from "../../src/migrate/mod.ts";
import { type Driver, sql } from "../../src/mod.ts";
import { createPgFixture, type PgFixture, sameSchema } from "./_fixture.ts";

const VERSIONS = ["1.0.0", "1.1.0", "2.0.0", "2.0.1"];

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
): Promise<void> {
	const fixture = await createPgFixture();
	const other = sameSchema(fixture.schema);
	try {
		await fixture.driver.exec(
			"create table applied (id serial primary key, version text not null, who text not null)",
		);
		await body(fixture, other);
	} finally {
		try {
			await other.close();
		} finally {
			await fixture.dispose();
		}
	}
}

/** A migrate instance whose every version records itself in `applied`, slowly. */
function instance(db: Driver, who: string, started?: () => void) {
	const migrate = createMigrate(db);
	for (const version of VERSIONS) {
		migrate.addVersion(version, async ({ db }) => {
			started?.();
			await db.query(
				sql`insert into applied (version, who) values (${version}, ${who})`,
			);
			// Long enough for a lock that did not exclude to let the other run in.
			await sleep(25);
		});
	}
	return migrate;
}

describe("pg/migrate", () => {
	test("two drivers on two pools calling up() at once apply each version once", () =>
		withTwoPools(async ({ driver: one }, two) => {
			const started = gate();
			const first = instance(one, "one", started.open).up();
			// The second starts while the first is inside a step, holding the lock.
			await started.opened;
			const second = instance(two, "two").up();
			assert.deepEqual(await Promise.all([first, second]), [VERSIONS.length, 0]);

			const { rows } = await one.query<{ version: string; who: string }>(
				"select version, who from applied order by id",
			);
			assert.deepEqual(
				rows,
				VERSIONS.map((version) => ({ version, who: "one" })),
			);
			const recorded = await two.query<{ version: string }>(
				"select version from __migrate__ order by id",
			);
			assert.deepEqual(
				recorded.rows.map((row) => row.version),
				VERSIONS,
			);
		}));

	test("two pools starting together: whichever wins applies all, the other none", () =>
		withTwoPools(async ({ driver: one }, two) => {
			const counts = await Promise.all([
				instance(one, "one").up(),
				instance(two, "two").up(),
			]);
			assert.deepEqual(
				[...counts].sort((a, b) => a - b),
				[0, VERSIONS.length],
			);
			const { rows } = await one.query<{ version: string; n: string }>(
				"select version, count(*) as n from applied group by version order by version",
			);
			assert.deepEqual(
				rows,
				VERSIONS.map((version) => ({ version, n: "1" })),
			);
		}));

	test("runs on two schemas do not wait for each other", async () => {
		const a = await createPgFixture();
		const b = await createPgFixture();
		try {
			const release = gate();
			const inside = gate();
			const holder = createMigrate(a.driver);
			holder.addVersion("1.0.0", async () => {
				inside.open();
				await release.opened;
			});
			const held = holder.up();
			await inside.opened;
			// The same table name on another schema is another lock.
			const other = createMigrate(b.driver);
			other.addVersion("1.0.0", () => undefined);
			assert.equal(await other.up(), 1);
			release.open();
			assert.equal(await held, 1);
		} finally {
			try {
				await a.dispose();
			} finally {
				await b.dispose();
			}
		}
	});
});
