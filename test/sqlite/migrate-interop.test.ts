// The migrate wiring and the package's own SQLite helper share one database file (plan doc
// 03 #2, D18): the version table's DDL is the package's, character for character. So a
// database taken to version 1 by the helper (`createSqliteMigrate`, over a raw
// `DatabaseSync`) is taken to version 2 by `createMigrate`, and the reverse, and a run of one
// excludes a run of the other: both hold SQLite's write lock for the length of a run.
//
// Adapter-specific by necessity: the helper takes a node:sqlite handle. Each side has a
// handle of its own on one file, as two processes would.
//
// Suite names start with `sqlite/`: `pnpm run test:sqlite` selects them by it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { createSqliteMigrate } from "@marianmeres/migrate/sqlite";
import { createMigrate } from "../../src/migrate/mod.ts";
import { BusyError, type Driver, sql } from "../../src/mod.ts";
import { openSqlite } from "../../src/sqlite/mod.ts";

/** One case: a database file, the helper's raw handle on it and a driver on it. */
async function withFile(
	body: (raw: DatabaseSync, driver: Driver, path: string) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "sqlkit-migrate-"));
	const path = join(dir, "db.sqlite");
	const driver = openSqlite(path);
	const raw = new DatabaseSync(path, { timeout: 5_000 });
	try {
		await driver.exec(
			"create table applied (id integer primary key, v text not null)",
		);
		await body(raw, driver, path);
	} finally {
		try {
			raw.close();
			await driver.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
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

/** The version table's DDL as SQLite stored it. */
async function ddl(db: Driver): Promise<unknown> {
	const { rows } = await db.query<{ sql: string }>(
		"select sql from sqlite_master where type = 'table' and name = '__migrate__'",
	);
	return rows[0]?.sql;
}

/** The helper over the raw handle: versions 1 and 2, each recorded in `applied` by name. */
function helper(raw: DatabaseSync) {
	const migrate = createSqliteMigrate(raw);
	for (const v of ["1", "2"]) {
		migrate.addVersion(
			`${v}.0.0`,
			({ db }) => {
				db.prepare("insert into applied (v) values (?)").run(`${v} by helper`);
			},
			({ db }) => {
				db.prepare("insert into applied (v) values (?)").run(
					`${v} down by helper`,
				);
			},
		);
	}
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

describe("sqlite/migrate-interop", () => {
	test("the helper takes it to version 1, createMigrate to version 2", () =>
		withFile(async (raw, driver) => {
			assert.equal(await helper(raw).up("1.0.0"), 1);
			const ours = wiring(driver);
			assert.equal(await ours.getActiveVersion(), "1.0.0");
			assert.equal(await ours.up(), 1);
			assert.deepEqual(await applied(driver), ["1 by helper", "2 by sqlkit"]);
			assert.deepEqual(await recorded(driver), ["1.0.0", "2.0.0"]);
			assert.equal(await helper(raw).getActiveVersion(), "2.0.0");
		}));

	test("createMigrate takes it to version 1, the helper to version 2, and back down", () =>
		withFile(async (raw, driver) => {
			assert.equal(await wiring(driver).up("1.0.0"), 1);
			assert.equal(await helper(raw).up(), 1);
			const ours = wiring(driver);
			assert.equal(await ours.getActiveVersion(), "2.0.0");
			assert.equal(await ours.down("1.0.0"), 1);
			assert.deepEqual(await applied(driver), [
				"1 by sqlkit",
				"2 by helper",
				"2 down by sqlkit",
			]);
			assert.deepEqual(await recorded(driver), ["1.0.0", "2.0.0", "1.0.0"]);
			assert.equal(await helper(raw).getActiveVersion(), "1.0.0");
		}));

	test("both make the same version table, character for character", async () => {
		let theirs: unknown;
		await withFile(async (raw, driver) => {
			await helper(raw).up("1.0.0");
			theirs = await ddl(driver);
		});
		await withFile(async (_raw, driver) => {
			await wiring(driver).up("1.0.0");
			assert.equal(await ddl(driver), theirs);
		});
		assert.match(String(theirs), /^CREATE TABLE __migrate__ \(/);
	});

	test("a run of either holds the write lock the other's run needs", () =>
		withFile(async (raw, driver, path) => {
			// A handle that does not wait: the lock is refused at once, not after a timeout
			// that would block the thread the holder needs to finish.
			const impatientRaw = new DatabaseSync(path, { timeout: 0 });
			const impatient = openSqlite(path, { busyTimeout: 0 });
			try {
				// createMigrate holds it: the helper's BEGIN IMMEDIATE is refused.
				const ours = createMigrate(driver);
				let inside!: () => void;
				const entered = new Promise<void>((resolve) => {
					inside = resolve;
				});
				let release!: () => void;
				const released = new Promise<void>((resolve) => {
					release = resolve;
				});
				ours.addVersion("1.0.0", async () => {
					inside();
					await released;
				});
				const run = ours.up();
				await entered;
				await assert.rejects(
					createSqliteMigrate(impatientRaw).up(),
					/database is locked/,
				);
				release();
				assert.equal(await run, 1);

				// The helper holds it: createMigrate's run is refused, as a typed error.
				const theirs = createSqliteMigrate(raw);
				let theirsInside!: () => void;
				const theirsEntered = new Promise<void>((resolve) => {
					theirsInside = resolve;
				});
				let theirsRelease!: () => void;
				const theirsReleased = new Promise<void>((resolve) => {
					theirsRelease = resolve;
				});
				theirs.addVersion("1.0.0", () => undefined);
				theirs.addVersion("1.1.0", async () => {
					theirsInside();
					await theirsReleased;
				});
				const theirRun = theirs.up();
				await theirsEntered;
				await assert.rejects(
					createMigrate(impatient).up(),
					(error: unknown) =>
						error instanceof Error && error.cause instanceof BusyError,
				);
				theirsRelease();
				assert.equal(await theirRun, 1);
				assert.deepEqual(await recorded(driver), ["1.0.0", "1.1.0"]);
			} finally {
				impatientRaw.close();
				await impatient.close();
			}
		}));
});
