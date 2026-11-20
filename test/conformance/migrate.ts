// The `migrate` conformance body: the migrate wiring over a `Driver` (plan doc 03 #2, D18),
// on every registered adapter. `up()` applies versions in order and records each, a second
// `up()` does nothing, `down()` and `uninstall()` reverse, a read creates no table, a bad
// table name is a `TypeError`, a worker's statements roll back with its step, and a failing
// step is undone alone, whichever way the adapter runs a step:
//
// - `capabilities.crossProcessLock` (a Postgres pool or client): each step is a transaction
//   of its own under the run's lock.
// - otherwise: the run is one transaction and each step a savepoint of it (backlog T26),
//   committed with what the steps before the failed one did.
//
// Runner-agnostic: no `node:test` here, so the same cases run inside workerd. Every case
// creates and disposes a database of its own. The SQL is portable between the dialects or
// written as `sql` fragments; only the check for a table's existence reads each dialect's
// catalog.

import assert from "node:assert/strict";
import { createMigrate, MIGRATE_TABLE } from "../../src/migrate/mod.ts";
import { type Driver, SqlError, sql } from "../../src/mod.ts";
import type { AdapterCase, Suite } from "./_suite.ts";

/** A promise and the function that resolves it: a gate a case opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** Whether the table `name` exists, read from the dialect's catalog. */
async function tableExists(db: Driver, name: string): Promise<boolean> {
	const { rows } = await db.query<{ found: unknown }>(
		db.dialect === "pg"
			? sql`select to_regclass(${name}) is not null as found`
			: sql`select count(*) > 0 as found from sqlite_master where type = 'table' and name = ${name}`,
	);
	const found = rows[0]?.found;
	return found === true || found === 1;
}

/** Every row of the version table, oldest first: what was recorded, `null` for none. */
async function recorded(db: Driver, table = MIGRATE_TABLE): Promise<(string | null)[]> {
	const { rows } = await db.query<{ version: string | null }>(
		`select version from ${table} order by id`,
	);
	return rows.map((row) => row.version);
}

/** The values of `log`, in the order they were written. */
async function logged(db: Driver): Promise<string[]> {
	const { rows } = await db.query<{ v: string }>(sql`select v from log order by n`);
	return rows.map((row) => row.v);
}

/** A failure whose message, or its cause's, says `boom`: what a worker of a case throws. */
function boom(error: unknown): boolean {
	const said = (value: unknown): boolean =>
		value instanceof Error && /boom/.test(value.message);
	return said(error) || (error instanceof Error && said(error.cause));
}

export function migrateContract(suite: Suite, adapter: AdapterCase): void {
	/** One case, on a database of its own holding an empty table `log`. */
	const test = (name: string, body: (db: Driver) => Promise<void>): void => {
		suite.test(name, async () => {
			const fixture = await adapter.create();
			try {
				await fixture.driver.exec(
					"create table log (n integer primary key, v text not null)",
				);
				await body(fixture.driver);
			} finally {
				await fixture.dispose();
			}
		});
	};

	/** Append `v` to `log`, through whichever handle the caller is in. */
	let next = 0;
	const log = (db: Driver, v: string): Promise<unknown> =>
		db.query(sql`insert into log (n, v) values (${++next}, ${v})`);

	test("migrate: up() applies the versions in semver order and records each", async (db) => {
		const migrate = createMigrate(db);
		// Registered out of order: semver decides, not registration.
		for (const version of ["1.0.10", "1.0.2", "1.0.1"]) {
			const table = `t_${version.replaceAll(".", "_")}`;
			migrate.addVersion(version, async ({ db }) => {
				await db.exec(`create table ${table} (id integer)`);
				await log(db, version);
			});
		}
		assert.equal(await migrate.up(), 3);
		assert.deepEqual(await logged(db), ["1.0.1", "1.0.2", "1.0.10"]);
		assert.deepEqual(await recorded(db), ["1.0.1", "1.0.2", "1.0.10"]);
		assert.equal(await migrate.getActiveVersion(), "1.0.10");
		for (const table of ["t_1_0_1", "t_1_0_2", "t_1_0_10"]) {
			assert.equal(await tableExists(db, table), true, table);
		}
	});

	test("migrate: a second up() does nothing", async (db) => {
		const migrate = createMigrate(db);
		migrate.addVersion("1.0.0", ({ db }) => log(db, "1.0.0"));
		migrate.addVersion("2.0.0", ({ db }) => log(db, "2.0.0"));
		assert.equal(await migrate.up(), 2);
		assert.equal(await migrate.up(), 0);
		// A second instance on the same database reads where the first left it.
		const again = createMigrate(db);
		again.addVersion("1.0.0", ({ db }) => log(db, "again 1.0.0"));
		again.addVersion("2.0.0", ({ db }) => log(db, "again 2.0.0"));
		assert.equal(await again.up(), 0);
		assert.deepEqual(await logged(db), ["1.0.0", "2.0.0"]);
		assert.deepEqual(await recorded(db), ["1.0.0", "2.0.0"]);
	});

	test("migrate: up() continues from the active version, registered later above it", async (db) => {
		const migrate = createMigrate(db);
		migrate.addVersion("1.0.0", ({ db }) => log(db, "1.0.0"));
		assert.equal(await migrate.up(), 1);
		migrate.addVersion("1.1.0", ({ db }) => log(db, "1.1.0"));
		assert.equal(await migrate.up(), 1);
		assert.deepEqual(await logged(db), ["1.0.0", "1.1.0"]);
		assert.deepEqual(await recorded(db), ["1.0.0", "1.1.0"]);
	});

	test("migrate: a failing step is undone alone, and the steps before it stay", async (db) => {
		const migrate = createMigrate(db);
		migrate.addVersion("1.0.0", async ({ db }) => {
			await db.exec("create table a (id integer)");
			await log(db, "1.0.0");
		});
		migrate.addVersion("2.0.0", async ({ db }) => {
			await db.exec("create table b (id integer)");
			await log(db, "2.0.0");
			throw new Error("boom");
		});
		await assert.rejects(migrate.up(), boom);

		// The failed step is undone, with its version mark.
		assert.equal(await tableExists(db, "b"), false);
		assert.ok(!(await logged(db)).includes("2.0.0"));

		// The step before it stays: committed on its own under a cross-process lock, and
		// with the run's one transaction, to which the failed step was a savepoint,
		// everywhere else.
		assert.equal(await migrate.getActiveVersion(), "1.0.0");
		assert.equal(await tableExists(db, "a"), true);
		assert.deepEqual(await logged(db), ["1.0.0"]);
		assert.deepEqual(await recorded(db), ["1.0.0"]);

		// Fixed, the next run takes it from where the failure left it.
		const fixed = createMigrate(db);
		fixed.addVersion("1.0.0", async ({ db }) => {
			await db.exec("create table a (id integer)");
			await log(db, "1.0.0");
		});
		fixed.addVersion("2.0.0", async ({ db }) => {
			await db.exec("create table b (id integer)");
			await log(db, "2.0.0");
		});
		assert.equal(await fixed.up(), 1);
		assert.deepEqual(await logged(db), ["1.0.0", "2.0.0"]);
		assert.equal(await fixed.getActiveVersion(), "2.0.0");
	});

	test("migrate: a worker's statements roll back with its step, a nested transaction's too", async (db) => {
		const migrate = createMigrate(db);
		migrate.addVersion("1.0.0", async ({ db }) => {
			await log(db, "worker");
			// A nested transaction joins the step's: it goes with the step's rollback.
			await db.transaction(async (tx) => {
				await log(tx, "nested");
				await tx.exec("create table c (id integer)");
			});
			assert.deepEqual(await logged(db), ["worker", "nested"]);
			throw new Error("boom");
		});
		await assert.rejects(migrate.up(), boom);
		assert.deepEqual(await logged(db), []);
		assert.equal(await tableExists(db, "c"), false);
		assert.equal(await migrate.getActiveVersion(), undefined);
		// The run itself was kept: the version table it made is there, and empty.
		assert.deepEqual(await recorded(db), []);
	});

	test("migrate: a step the database refused is undone alone too, and the run goes on later", async (db) => {
		// A failed statement, not a thrown error: on Postgres it aborts the transaction
		// the step is in, which only the step's own rollback lifts.
		const migrate = createMigrate(db);
		migrate.addVersion("1.0.0", ({ db }) => log(db, "1.0.0"));
		migrate.addVersion("2.0.0", async ({ db }) => {
			await log(db, "2.0.0");
			await db.query("insert into no_such_table values (1)");
		});
		migrate.addVersion("3.0.0", ({ db }) => log(db, "3.0.0"));
		await assert.rejects(
			migrate.up(),
			(error) => error instanceof Error && error.cause instanceof SqlError,
		);
		assert.deepEqual(await logged(db), ["1.0.0"]);
		assert.deepEqual(await recorded(db), ["1.0.0"]);
		assert.equal(await migrate.getActiveVersion(), "1.0.0");

		// The connection is in no transaction, and no lock is left held.
		const fixed = createMigrate(db);
		fixed.addVersion("1.0.0", ({ db }) => log(db, "1.0.0"));
		fixed.addVersion("2.0.0", ({ db }) => log(db, "2.0.0 fixed"));
		fixed.addVersion("3.0.0", ({ db }) => log(db, "3.0.0"));
		assert.equal(await fixed.up(), 2);
		assert.deepEqual(await logged(db), ["1.0.0", "2.0.0 fixed", "3.0.0"]);
		assert.deepEqual(await recorded(db), ["1.0.0", "2.0.0", "3.0.0"]);
	});

	test("migrate: down() and uninstall() reverse", async (db) => {
		const migrate = createMigrate(db);
		for (const [i, name] of ["a", "b", "c"].entries()) {
			const version = `${i + 1}.0.0`;
			migrate.addVersion(
				version,
				({ db }) => db.exec(`create table ${name} (id integer)`),
				({ db }) => db.exec(`drop table ${name}`),
			);
		}
		assert.equal(await migrate.up(), 3);

		assert.equal(await migrate.down("1.0.0"), 2);
		assert.equal(await migrate.getActiveVersion(), "1.0.0");
		assert.equal(await tableExists(db, "a"), true);
		assert.equal(await tableExists(db, "b"), false);
		assert.equal(await tableExists(db, "c"), false);

		assert.equal(await migrate.uninstall(), 1);
		assert.equal(await migrate.getActiveVersion(), undefined);
		assert.equal(await tableExists(db, "a"), false);
		// The table is insert-only: the history stays, its newest row says "none".
		assert.deepEqual(await recorded(db), [
			"1.0.0",
			"2.0.0",
			"3.0.0",
			"2.0.0",
			"1.0.0",
			null,
		]);

		// And up again from nothing.
		assert.equal(await migrate.up(), 3);
		assert.equal(await migrate.getActiveVersion(), "3.0.0");
	});

	test("migrate: getActiveVersion() on a fresh database is undefined and creates no table", async (db) => {
		const migrate = createMigrate(db);
		migrate.addVersion("1.0.0", () => undefined);
		assert.equal(await migrate.getActiveVersion(), undefined);
		assert.deepEqual(await migrate.status(), {
			active: undefined,
			latest: "1.0.0",
			isAtLatest: false,
			pending: ["1.0.0"],
		});
		assert.equal((await migrate.plan("up")).steps.length, 1);
		assert.equal(await tableExists(db, MIGRATE_TABLE), false);
	});

	test("migrate: an invalid table name is a TypeError", async (db) => {
		for (const table of ["", "1abc", "a-b", "a b", "a;drop table log", 'a"b', "ä"]) {
			assert.throws(
				() => createMigrate(db, { table }),
				(error: unknown) =>
					error instanceof TypeError && /table name/.test(error.message),
				JSON.stringify(table),
			);
		}
		for (const table of [42, ["abc"], null]) {
			assert.throws(
				() => createMigrate(db, { table: table as unknown as string }),
				TypeError,
			);
		}
		assert.equal(await tableExists(db, MIGRATE_TABLE), false);
	});

	test("migrate: a custom table keeps the versions; the default one is not created", async (db) => {
		const migrate = createMigrate(db, { table: "My_Versions_2" });
		migrate.addVersion("1.0.0", ({ db }) => log(db, "1.0.0"));
		assert.equal(await migrate.up(), 1);
		assert.deepEqual(await recorded(db, "My_Versions_2"), ["1.0.0"]);
		assert.equal(await tableExists(db, MIGRATE_TABLE), false);
		assert.equal(await createMigrate(db).getActiveVersion(), undefined);
	});

	test("migrate: workers receive the driver and the extra context", async (db) => {
		const seen: unknown[] = [];
		const migrate = createMigrate(db, { context: { tenant: "acme" } });
		migrate.addVersion("1.0.0", (context) => {
			seen.push(context.db === db, context.tenant);
		});
		assert.equal(await migrate.up(), 1);
		assert.deepEqual(seen, [true, "acme"]);
	});

	test("migrate: setActiveVersion() outside a run creates the table and records", async (db) => {
		const migrate = createMigrate(db);
		migrate.addVersion("1.0.0", ({ db }) => log(db, "1.0.0"));
		migrate.addVersion("2.0.0", ({ db }) => log(db, "2.0.0"));
		assert.equal(await migrate.setActiveVersion("1.0.0"), "1.0.0");
		assert.deepEqual(await recorded(db), ["1.0.0"]);
		// Only what is above it runs.
		assert.equal(await migrate.up(), 1);
		assert.deepEqual(await logged(db), ["2.0.0"]);
		assert.deepEqual(await recorded(db), ["1.0.0", "2.0.0"]);
	});

	test("migrate: two instances running up() at once apply each version once", async (db) => {
		const versions = ["1.0.0", "2.0.0", "3.0.0"];
		const instance = (who: string) => {
			const migrate = createMigrate(db);
			for (const version of versions) {
				migrate.addVersion(version, async ({ db }) => {
					await log(db, `${version} by ${who}`);
					// A real timer: the other run gets every chance to step in.
					await new Promise((resolve) => setTimeout(resolve, 5));
				});
			}
			return migrate;
		};
		const holding = gate();
		const one = instance("one");
		one.addVersion("0.0.1", async () => {
			holding.open();
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const first = one.up();
		await holding.opened;
		const second = instance("two").up();
		const counts = await Promise.all([first, second]);
		assert.deepEqual(counts, [4, 0]);
		assert.deepEqual(
			(await logged(db)).map((v) => v.split(" ")[0]),
			["1.0.0", "2.0.0", "3.0.0"],
		);
		assert.deepEqual(await recorded(db), ["0.0.1", ...versions]);
	});
}
