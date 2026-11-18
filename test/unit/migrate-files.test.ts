// SQL files as versions (plan doc 03 #4, D19): `addSqlFiles` against temporary directories
// under `os.tmpdir()`. What loads and in what order, what is ignored, every refusal (each
// naming its file and registering nothing), what the workers hand to `exec`; then one run
// of loaded files through `createMigrate` on node:sqlite, which finds the tables.
//
// A unit suite, not a conformance body: loading is Node-only and talks to no database. The
// one run on node:sqlite shows the files reach a real `exec`; how a step runs on each
// adapter is the `migrate` body's.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Migrate } from "@marianmeres/migrate";
import { addSqlFiles } from "../../src/migrate/files.ts";
import { createMigrate, type MigrateContext } from "../../src/migrate/mod.ts";
import type { Driver } from "../../src/mod.ts";
import { openSqlite } from "../../src/sqlite/mod.ts";

/** A subdirectory, in a {@link withDir} listing. */
const DIR = Symbol("dir");

/** What a temporary directory holds: file name to text, or a subdirectory's listing. */
interface Listing {
	[name: string]: string | { [DIR]: Listing };
}

/** A subdirectory holding `listing`. */
const subdir = (listing: Listing = {}) => ({ [DIR]: listing });

async function write(dir: string, listing: Listing): Promise<void> {
	for (const [name, content] of Object.entries(listing)) {
		const path = join(dir, name);
		if (typeof content === "string") {
			await writeFile(path, content);
		} else {
			await mkdir(path);
			await write(path, content[DIR]);
		}
	}
}

/** Runs `body` on a fresh directory holding `listing`, removed afterwards. */
async function withDir(
	listing: Listing,
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sqlkit-files-"));
	try {
		await write(dir, listing);
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** An in-memory instance whose workers' `db` records every script it is given. */
function recording(): { migrate: Migrate<MigrateContext>; scripts: string[] } {
	const scripts: string[] = [];
	const db = {
		exec: async (script: string) => {
			scripts.push(script);
		},
	} as unknown as Driver;
	return { migrate: new Migrate<MigrateContext>({}, { db }), scripts };
}

/** A value past the types, as untyped code would pass it. */
// biome-ignore lint/suspicious/noExplicitAny: the cases call addSqlFiles as untyped code
const loose = (value: unknown): any => value;

describe("addSqlFiles: loading", () => {
	test("three versions load in semver order, whatever their file order", async () => {
		// By name the order is 1.1, 10, 2; by semver it is 1.1, 2, 10.
		await withDir(
			{ "10.up.sql": "", "2.up.sql": "", "1.1.up.sql": "" },
			async (dir) => {
				const { migrate } = recording();
				const versions = await addSqlFiles(migrate, dir);
				assert.deepEqual(versions, ["1.1.0", "2.0.0", "10.0.0"]);
				assert.deepEqual(migrate.available, versions);
			},
		);
	});

	test("a prerelease sorts before its release, and a leading v is dropped", async () => {
		const listing = {
			"v3.up.sql": "",
			"3.0.0-rc.10.up.sql": "",
			"3.0.0-rc.2.up.sql": "",
		};
		await withDir(listing, async (dir) => {
			const versions = await addSqlFiles(recording().migrate, dir);
			assert.deepEqual(versions, ["3.0.0-rc.2", "3.0.0-rc.10", "3.0.0"]);
		});
	});

	test("a labelled file loads, its label the version's comment", async () => {
		const listing = {
			"1__create_users.up.sql": "",
			"1__create_users.down.sql": "",
			"2.up.sql": "",
			"3__add__index.v2.up.sql": "",
		};
		await withDir(listing, async (dir) => {
			const { migrate } = recording();
			assert.deepEqual(await addSqlFiles(migrate, dir), [
				"1.0.0",
				"2.0.0",
				"3.0.0",
			]);
			assert.deepEqual(
				migrate.versions.map((v) => v.comment),
				["create_users", undefined, "add__index.v2"],
			);
		});
	});

	test("an up and a down pair by version, the label being the up file's", async () => {
		await withDir({ "1__new.up.sql": "", "1.0__old.down.sql": "" }, async (dir) => {
			const { migrate } = recording();
			assert.deepEqual(await addSqlFiles(migrate, dir), ["1.0.0"]);
			assert.equal(migrate.versions[0]?.comment, "new");
			assert.equal(migrate.versions[0]?.isReversible, true);
		});
	});

	test("a version without a down file is irreversible", async () => {
		await withDir(
			{ "1.up.sql": "", "1.down.sql": "", "2.up.sql": "" },
			async (dir) => {
				const { migrate, scripts } = recording();
				await addSqlFiles(migrate, dir);
				assert.deepEqual(
					migrate.versions.map((v) => [v.version, v.isReversible]),
					[
						["1.0.0", true],
						["2.0.0", false],
					],
				);
				await migrate.up("latest");
				// Leaving 2.0.0 is refused before any worker runs.
				await assert.rejects(
					migrate.down("initial"),
					/"2\.0\.0" is irreversible/,
				);
				assert.equal(scripts.length, 2);
			},
		);
	});

	test("other files are ignored and subdirectories are not read", async () => {
		const listing = {
			"README.md": "# migrations",
			".DS_Store": "",
			"notes.txt": "",
			"1.up.sql.bak": "",
			"1.up.sql": "",
			sub: subdir({ "2.up.sql": "", "nonsense.sql": "" }),
			"3.up.sql": subdir(),
		};
		await withDir(listing, async (dir) => {
			assert.deepEqual(await addSqlFiles(recording().migrate, dir), ["1.0.0"]);
		});
	});

	test("a symbolic link to a file loads like the file", async () => {
		await withDir({ shared: subdir({ "users.sql": "select 1;" }) }, async (outer) => {
			await withDir({ "1.up.sql": "" }, async (dir) => {
				await symlink(join(outer, "shared", "users.sql"), join(dir, "2.up.sql"));
				const { migrate, scripts } = recording();
				assert.deepEqual(await addSqlFiles(migrate, dir), ["1.0.0", "2.0.0"]);
				await migrate.up("latest");
				assert.deepEqual(scripts, ["", "select 1;"]);
			});
		});
	});

	test("a directory that does not exist rejects with the file system's error", async () => {
		await withDir({}, async (dir) => {
			const { migrate } = recording();
			await assert.rejects(
				addSqlFiles(migrate, join(dir, "missing")),
				(error: unknown) => (error as { code?: unknown }).code === "ENOENT",
			);
			assert.deepEqual(migrate.available, []);
		});
	});

	test("on an instance that has versions already, it adds its own", async () => {
		await withDir({ "2.up.sql": "", "3.up.sql": "" }, async (dir) => {
			const { migrate } = recording();
			migrate.addVersion("1.0.0", () => {});
			assert.deepEqual(await addSqlFiles(migrate, dir), ["2.0.0", "3.0.0"]);
			assert.deepEqual(migrate.available, ["1.0.0", "2.0.0", "3.0.0"]);
		});
	});

	test("the workers hand their file's text to exec, without a byte-order mark", async () => {
		const listing = {
			"1.up.sql": "create table a (id int);\ncreate table b (id int);\n",
			"1.down.sql": "\uFEFFdrop table b;\ndrop table a;\n",
			"2.up.sql": "\uFEFFcreate table c (id int);",
			"2.down.sql": "drop table c;",
		};
		await withDir(listing, async (dir) => {
			const { migrate, scripts } = recording();
			await addSqlFiles(migrate, dir);
			await migrate.up("latest");
			await migrate.uninstall();
			assert.deepEqual(scripts, [
				"create table a (id int);\ncreate table b (id int);\n",
				"create table c (id int);",
				"drop table c;",
				"drop table b;\ndrop table a;\n",
			]);
		});
	});

	test("the text is read when registered, not when the version runs", async () => {
		await withDir({ "1.up.sql": "select 1;" }, async (dir) => {
			const { migrate, scripts } = recording();
			await addSqlFiles(migrate, dir);
			await writeFile(join(dir, "1.up.sql"), "select 2;");
			await migrate.up("latest");
			assert.deepEqual(scripts, ["select 1;"]);
		});
	});
});

describe("addSqlFiles: refusals", () => {
	/** Each case: what the directory holds, the file the refusal names, and its reason. */
	const cases: {
		name: string;
		listing: Listing;
		names: string | null;
		reason: RegExp;
	}[] = [
		{
			name: "a .sql file that does not match the pattern",
			listing: { "1.up.sql": "", "schema.sql": "" },
			names: "schema.sql",
			reason: /does not match <version>\[__<label>\]\.up\.sql or \.down\.sql/,
		},
		{
			name: "a .sql file with no direction",
			listing: { "1.sql": "" },
			names: "1.sql",
			reason: /does not match/,
		},
		{
			name: "a .sql file whose suffix is in another case",
			listing: { "1.up.sql": "", "2.UP.SQL": "" },
			names: "2.UP.SQL",
			reason: /does not match/,
		},
		{
			name: "an empty label",
			listing: { "1__.up.sql": "" },
			names: "1__.up.sql",
			reason: /the label after __ is empty/,
		},
		{
			name: "a version semver rejects (four parts)",
			listing: { "1.2.3.4.up.sql": "" },
			names: "1.2.3.4.up.sql",
			reason: /"1\.2\.3\.4" is not a version semver accepts/,
		},
		{
			name: "a version semver rejects (a word)",
			listing: { "1.up.sql": "", "init__users.up.sql": "" },
			names: "init__users.up.sql",
			reason: /"init" is not a version semver accepts/,
		},
		{
			name: "a down file with no up file",
			listing: { "1.up.sql": "", "1.down.sql": "", "2__x.down.sql": "" },
			names: "2__x.down.sql",
			reason: /a down file with no up file \(version 2\.0\.0\)/,
		},
		{
			name: "two up files for one version, by label",
			listing: { "1.up.sql": "", "1__again.up.sql": "" },
			names: "1__again.up.sql",
			reason: /a second up file for version 1\.0\.0, after .*1\.up\.sql/,
		},
		{
			name: "two up files for one version, spelt differently",
			listing: { "1.up.sql": "", "1.0.0.up.sql": "" },
			names: "1.up.sql",
			reason: /a second up file for version 1\.0\.0, after .*1\.0\.0\.up\.sql/,
		},
		{
			name: "two up files whose versions semver orders as equal",
			listing: { "01.up.sql": "", "1.up.sql": "" },
			names: "1.up.sql",
			reason: /a second up file for version 01\.0\.0/,
		},
		{
			name: "two up files differing in build metadata only",
			listing: { "1.0.0+a.up.sql": "", "1.0.0+b.up.sql": "" },
			names: "1.0.0+b.up.sql",
			reason: /a second up file for version 1\.0\.0\+a/,
		},
		{
			name: "two down files for one version",
			listing: { "1.up.sql": "", "1.down.sql": "", "1.0.down.sql": "" },
			names: "1.down.sql",
			reason: /a second down file for version 1\.0\.0, after .*1\.0\.down\.sql/,
		},
		{
			name: "an empty directory",
			listing: {},
			names: null,
			reason: /no version in it/,
		},
		{
			name: "a directory with no version file in it",
			listing: { "README.md": "", sub: subdir({ "1.up.sql": "" }) },
			names: null,
			reason: /no version in it/,
		},
	];

	for (const { name, listing, names, reason } of cases) {
		test(`${name} is refused, naming it, and nothing is registered`, async () => {
			await withDir(listing, async (dir) => {
				const { migrate } = recording();
				const path = names === null ? dir : join(dir, names);
				await assert.rejects(addSqlFiles(migrate, dir), (error: unknown) => {
					assert.ok(error instanceof TypeError, `not a TypeError: ${error}`);
					assert.ok(
						error.message.startsWith(`addSqlFiles: ${path}: `),
						error.message,
					);
					assert.match(error.message, reason);
					return true;
				});
				assert.deepEqual(migrate.available, []);
			});
		});
	}

	test("a version the instance already has is refused, and nothing is registered", async () => {
		await withDir(
			{ "1.up.sql": "", "01.1.up.sql": "", "2.up.sql": "" },
			async (dir) => {
				const { migrate } = recording();
				migrate.addVersion("1.1.0", () => {});
				await assert.rejects(addSqlFiles(migrate, dir), (error: unknown) => {
					assert.ok(error instanceof TypeError);
					assert.ok(
						error.message.startsWith(
							`addSqlFiles: ${join(dir, "01.1.up.sql")}: `,
						),
						error.message,
					);
					assert.match(error.message, /version 1\.1\.0 is already registered/);
					return true;
				});
				assert.deepEqual(migrate.available, ["1.1.0"]);
			},
		);
	});

	test("an argument that is not what it says is a TypeError, as a rejection", async () => {
		await withDir({ "1.up.sql": "" }, async (dir) => {
			const { migrate } = recording();
			for (const bad of [null, undefined, {}, { addVersion() {} }, "migrate"]) {
				await assert.rejects(
					addSqlFiles(loose(bad), dir),
					/addSqlFiles\(migrate, dir\) takes a Migrate instance/,
				);
			}
			for (const bad of ["", 42, null, undefined]) {
				await assert.rejects(
					addSqlFiles(migrate, loose(bad)),
					/addSqlFiles\(migrate, dir\) takes a directory path/,
				);
			}
			assert.deepEqual(migrate.available, []);
		});
	});
});

describe("addSqlFiles: through createMigrate on node:sqlite", () => {
	test("loaded files run, and the tables are there; uninstall drops them", async () => {
		const listing = {
			"1__users.up.sql": [
				"-- the users, and an index: two statements in one file",
				"create table users (id integer primary key, email text not null);",
				"create unique index users_email on users (email);",
				"",
			].join("\n"),
			"1__users.down.sql": "drop table users;\n",
			"2__posts.up.sql":
				"﻿create table posts (\n\tid integer primary key,\n" +
				"\tuser_id integer not null references users (id)\n);\n",
			"2__posts.down.sql": "drop table posts;\n",
			"README.md": "Not a version.",
		};
		await withDir(listing, async (dir) => {
			const db = openSqlite();
			try {
				// An instance with extra context is accepted as it is.
				const migrate = createMigrate(db, { context: { tenant: "t1" } });
				assert.deepEqual(await addSqlFiles(migrate, dir), ["1.0.0", "2.0.0"]);

				const objects = async () => {
					const { rows } = await db.query<{ type: string; name: string }>(
						"select type, name from sqlite_master " +
							"where name in ('users', 'users_email', 'posts') order by name",
					);
					return rows.map((row) => `${row.type} ${row.name}`);
				};

				await migrate.up("latest");
				assert.deepEqual(await objects(), [
					"table posts",
					"table users",
					"index users_email",
				]);
				assert.equal(await migrate.getActiveVersion(), "2.0.0");

				await migrate.uninstall();
				assert.deepEqual(await objects(), []);
				assert.equal(await migrate.getActiveVersion(), undefined);
			} finally {
				await db.close();
			}
		});
	});
});
