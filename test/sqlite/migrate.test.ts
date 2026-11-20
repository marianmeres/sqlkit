// The migrate wiring's one exception to "a failed step is undone alone" (backlog T26): a
// step whose savepoint the database would not roll back to. What the step did may still be
// in the run's transaction, so the whole run is rolled back rather than committed with it.
//
// Adapter-specific by necessity: no real database refuses a `ROLLBACK TO` on request, so
// the driver here is node:sqlite's with its `savepoint` replaced by one that does. The
// conformance body (`test/conformance/migrate.ts`) holds every adapter to the rule itself.
//
// Suite names start with `sqlite/`: `pnpm run test:sqlite` selects them by it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMigrate, MIGRATE_TABLE } from "../../src/migrate/mod.ts";
import type { Driver } from "../../src/mod.ts";
import { openSqlite } from "../../src/sqlite/mod.ts";

/** The tables of the database, by name. */
async function tables(db: Driver): Promise<string[]> {
	const { rows } = await db.query<{ name: string }>(
		"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
	);
	return rows.map((row) => row.name);
}

/** Two versions, the second of which writes and then fails. */
function versions(db: Driver) {
	const migrate = createMigrate(db);
	migrate.addVersion("1.0.0", ({ db }) => db.exec("create table a (id integer)"));
	migrate.addVersion("2.0.0", async ({ db }) => {
		await db.exec("create table b (id integer)");
		throw new Error("boom");
	});
	return migrate;
}

describe("sqlite/migrate: a step that could not be undone", () => {
	test("a failed step whose savepoint was rolled back to leaves the steps before it", async () => {
		const db = openSqlite();
		try {
			await assert.rejects(versions(db).up(), /boom/);
			assert.deepEqual(await tables(db), [MIGRATE_TABLE, "a"]);
		} finally {
			await db.close();
		}
	});

	test("a failed step whose savepoint could not be rolled back to takes the whole run with it", async () => {
		const real = openSqlite();
		try {
			// A savepoint that, when its callback fails, is not rolled back to: it
			// answers with the refusal, and what the callback wrote is still in the
			// transaction around it.
			const refusal = new Error("no such savepoint");
			const db: Driver = {
				...real,
				async savepoint(fn) {
					try {
						return await fn(db);
					} catch {
						throw refusal;
					}
				},
			};
			// The run reports the step's own failure, as it does when the step was undone:
			// what tells the two apart is what is left behind.
			await assert.rejects(versions(db).up(), /boom/);
			// Nothing was committed: not the failed step's table, which the refused
			// rollback left in the transaction, nor the step before it, nor the
			// version table the run made.
			assert.deepEqual(await tables(real), []);

			// The driver is in no transaction, and a run on it starts from nothing.
			await assert.rejects(versions(real).up(), /boom/);
			assert.deepEqual(await tables(real), [MIGRATE_TABLE, "a"]);
		} finally {
			await real.close();
		}
	});
});
