// The migrate wiring and the package's own Postgres helper share one database (plan doc
// 03 #2, D18): the version table's DDL is the package's, character for character, and the
// run lock `migrate:<table>` gives the same advisory keys. So a database taken to version 1
// by the helper (`createPgMigrate`, over a raw pool) is taken to version 2 by `createMigrate`,
// and the reverse, and a run of one waits for a run of the other.
//
// Adapter-specific by necessity: the helper takes a node-postgres pool. Each case runs on a
// schema of its own; the helper's pool is pointed at it with `search_path` set at connect,
// as a deployment's would be.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createPgMigrate } from "@marianmeres/migrate/pg";
import pg from "pg";
import { createMigrate } from "../../src/migrate/mod.ts";
import { type Driver, sql } from "../../src/mod.ts";
import { testPgConfig } from "../_env.ts";
import { createPgFixture, type PgFixture } from "./_fixture.ts";

/** One case, on a schema of its own, with a raw pool on that schema for the helper. */
async function withHelperPool(
	body: (fixture: PgFixture, pool: pg.Pool) => Promise<void>,
): Promise<void> {
	const fixture = await createPgFixture();
	const pool = new pg.Pool({
		...testPgConfig(),
		max: 2,
		options: `-c search_path=${fixture.schema}`,
	});
	try {
		await fixture.driver.exec(
			"create table applied (id serial primary key, v text not null)",
		);
		await body(fixture, pool);
	} finally {
		try {
			await pool.end();
		} finally {
			await fixture.dispose();
		}
	}
}

/** What the workers applied, in order. */
async function applied(db: Driver): Promise<string[]> {
	const { rows } = await db.query<{ v: string }>("select v from applied order by id");
	return rows.map((row) => row.v);
}

/** Every row of the version table, oldest first. */
async function recorded(db: Driver): Promise<(string | null)[]> {
	const { rows } = await db.query<{ version: string | null }>(
		"select version from __migrate__ order by id",
	);
	return rows.map((row) => row.version);
}

/** The version table's columns as the catalog has them. */
async function columns(db: Driver): Promise<unknown[]> {
	const { rows } = await db.query(
		`select column_name, data_type, is_nullable, column_default, is_identity
		from information_schema.columns
		where table_schema = current_schema() and table_name = '__migrate__'
		order by ordinal_position`,
	);
	return rows;
}

/** The helper over the raw pool: versions 1 and 2, each recorded in `applied` by name. */
function helper(pool: pg.Pool) {
	const migrate = createPgMigrate(pool);
	migrate.addVersion(
		"1.0.0",
		({ client }) => client.query("insert into applied (v) values ('1 by helper')"),
		({ client }) =>
			client.query("insert into applied (v) values ('1 down by helper')"),
	);
	migrate.addVersion(
		"2.0.0",
		({ client }) => client.query("insert into applied (v) values ('2 by helper')"),
		({ client }) =>
			client.query("insert into applied (v) values ('2 down by helper')"),
	);
	return migrate;
}

/** The wiring over a driver: the same versions, recorded as its own. */
function wiring(db: Driver) {
	const migrate = createMigrate(db);
	for (const v of ["1", "2"]) {
		migrate.addVersion(
			`${v}.0.0`,
			({ db }) =>
				db.query(sql`insert into applied (v) values (${`${v} by sqlkit`})`),
			({ db }) =>
				db.query(sql`insert into applied (v) values (${`${v} down by sqlkit`})`),
		);
	}
	return migrate;
}

describe("pg/migrate-interop", () => {
	test("the helper takes it to version 1, createMigrate to version 2", () =>
		withHelperPool(async ({ driver }, pool) => {
			assert.equal(await helper(pool).up("1.0.0"), 1);
			const ours = wiring(driver);
			assert.equal(await ours.getActiveVersion(), "1.0.0");
			assert.equal(await ours.up(), 1);
			assert.deepEqual(await applied(driver), ["1 by helper", "2 by sqlkit"]);
			assert.deepEqual(await recorded(driver), ["1.0.0", "2.0.0"]);
			assert.equal(await helper(pool).getActiveVersion(), "2.0.0");
		}));

	test("createMigrate takes it to version 1, the helper to version 2, and back down", () =>
		withHelperPool(async ({ driver }, pool) => {
			const before = await (async () => {
				const ours = wiring(driver);
				assert.equal(await ours.up("1.0.0"), 1);
				return columns(driver);
			})();
			assert.equal(await helper(pool).up(), 1);
			// The helper's `create table if not exists` found the table as it would have
			// made it: nothing to add, nothing changed.
			assert.deepEqual(await columns(driver), before);
			const ours = wiring(driver);
			assert.equal(await ours.getActiveVersion(), "2.0.0");
			assert.equal(await ours.down("1.0.0"), 1);
			assert.deepEqual(await applied(driver), [
				"1 by sqlkit",
				"2 by helper",
				"2 down by sqlkit",
			]);
			assert.deepEqual(await recorded(driver), ["1.0.0", "2.0.0", "1.0.0"]);
			assert.equal(await helper(pool).getActiveVersion(), "1.0.0");
		}));

	test("both make the same version table", async () => {
		let theirs: unknown[] = [];
		await withHelperPool(async ({ driver }, pool) => {
			await helper(pool).up("1.0.0");
			theirs = await columns(driver);
		});
		await withHelperPool(async ({ driver }) => {
			await wiring(driver).up("1.0.0");
			assert.deepEqual(await columns(driver), theirs);
		});
		assert.equal(theirs.length, 3);
	});

	test("a run of either waits for a run of the other, then reads what it left", () =>
		withHelperPool(async ({ driver }, pool) => {
			const order: string[] = [];
			let inside!: () => void;
			const entered = new Promise<void>((resolve) => {
				inside = resolve;
			});
			const ours = createMigrate(driver);
			ours.addVersion("1.0.0", async () => {
				order.push("sqlkit in");
				inside();
				// Long enough for a lock that did not exclude to let the helper in: it
				// polls every 10 ms at first.
				await sleep(150);
				order.push("sqlkit out");
			});
			const theirs = createPgMigrate(pool);
			theirs.addVersion("1.0.0", () => {
				order.push("helper ran 1.0.0");
			});
			theirs.addVersion("1.1.0", () => {
				order.push("helper ran 1.1.0");
			});
			const first = ours.up();
			await entered;
			const second = theirs.up();
			assert.deepEqual(await Promise.all([first, second]), [1, 1]);
			// The helper waited, then found 1.0.0 applied and ran only what is above it.
			assert.deepEqual(order, ["sqlkit in", "sqlkit out", "helper ran 1.1.0"]);

			// And the reverse: the helper holds the lock, createMigrate waits for it.
			order.length = 0;
			let helperInside!: () => void;
			const helperEntered = new Promise<void>((resolve) => {
				helperInside = resolve;
			});
			theirs.addVersion("1.2.0", async () => {
				order.push("helper in");
				helperInside();
				await sleep(150);
				order.push("helper out");
			});
			const third = theirs.up();
			await helperEntered;
			ours.addVersion("1.1.0", () => {
				order.push("sqlkit ran 1.1.0");
			});
			ours.addVersion("1.2.0", () => {
				order.push("sqlkit ran 1.2.0");
			});
			ours.addVersion("1.3.0", () => {
				order.push("sqlkit ran 1.3.0");
			});
			assert.deepEqual(await Promise.all([third, ours.up()]), [1, 1]);
			assert.deepEqual(order, ["helper in", "helper out", "sqlkit ran 1.3.0"]);
		}));
});
