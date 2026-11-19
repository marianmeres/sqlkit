// The node:sqlite adapter's statement cache: which texts are compiled once and run again,
// how many are kept, which is dropped and what empties the cache, and that a kept
// statement answers as one compiled for the call would: after a schema change, a changed
// setting, a failure, a call from inside itself, and a handle closed under the driver.
// One case pins where it does not, which is why a host's own handle keeps none unless
// asked.
//
// Adapter-specific: every case counts what the handle was asked to compile
// (`DatabaseSync.prototype.prepare`), which no other adapter has. What a statement answers
// is the contract's, and the conformance bodies hold this adapter to it with the cache on.
//
// Statements are kept only where node:sqlite reads the columns of a statement SQLite
// recompiled: Node 24.20+ and 26.6+, which is the package's `engines`. `engines` only
// warns, so the adapter asks the runtime, and this suite is how that is checked: run with
// an older Node it is green too. `compiles` is what to expect on the Node it runs on, and
// the first case checks that the adapter and the version agree.
//
// Suite names start with `sqlite/`: `pnpm run test:sqlite` selects them by it.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { describe, type TestContext, test } from "node:test";
import {
	type Driver,
	ForeignKeyViolationError,
	SqlError,
	sql,
	UniqueViolationError,
} from "../../src/mod.ts";
import {
	createSqliteDriver,
	openSqlite,
	type SqliteDriverOptions,
} from "../../src/sqlite/mod.ts";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

/**
 * Whether this Node's node:sqlite reads the columns of a recompiled statement, by its
 * version: from 24.20 on the 24 line, from 26.6 on, and on no 25. The adapter asks the
 * runtime instead; the two are compared below.
 */
const KEEPS = major > 26 || (major === 26 && minor >= 6) || (major === 24 && minor >= 20);

/** How often `calls` runs of one kept text are compiled: once, where statements are kept. */
const compiles = (calls: number): number => (KEEPS ? 1 : calls);

/** A host's own handle keeps statements only when asked: asked, here. */
const KEEPING: SqliteDriverOptions = { statementCache: 8 };

/**
 * Counts, for the length of the test, how often node:sqlite is asked to compile a text.
 * By text and on any handle, so a database `openSqlite` opened is counted too; the
 * adapter's question to the runtime is another text, on a handle of its own.
 */
function countCompiles(t: TestContext): (text: string) => number {
	const spy = t.mock.method(DatabaseSync.prototype, "prepare");
	return (text) => spy.mock.calls.filter((call) => call.arguments[0] === text).length;
}

/** A temporary directory for database files, removed after `fn`. */
async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "sqlkit-sqlite-cache-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("sqlite/statement-cache: what is kept", () => {
	test("statements are kept exactly where node:sqlite rereads a recompiled statement's columns", async (t) => {
		// The defect itself, on a bare handle: a statement held across an ALTER TABLE.
		const bare = new DatabaseSync(":memory:");
		bare.exec("create table item (a); insert into item (a) values (1)");
		const held = bare.prepare("select * from item");
		held.all();
		bare.exec("alter table item add column b");
		const rereads = Object.keys(held.all()[0] ?? {}).length === 2;
		bare.close();
		assert.equal(
			rereads,
			KEEPS,
			`Node ${process.versions.node}: the versions this file and the docs name are off`,
		);

		// And what the adapter made of it.
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			await db.query("select 1 as probe");
			await db.query("select 1 as probe");
			assert.equal(compiled("select 1 as probe"), rereads ? 1 : 2);
		} finally {
			await db.close();
		}
	});

	test("a text is compiled once and run again with other values, on either tier", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			await db.exec("create table item (id integer primary key, name text)");
			const insert = "insert into item (id, name) values (?, ?)";
			const select = "select name from item where id = ?";
			for (const [id, name] of [
				[1, "one"],
				[2, "two"],
				[3, "three"],
			] as const) {
				assert.equal((await db.query(insert, [id, name])).rowCount, 1);
			}
			assert.deepEqual((await db.query(select, [1])).rows, [{ name: "one" }]);
			assert.deepEqual((await db.query(select, [3])).rows, [{ name: "three" }]);
			assert.deepEqual(db.sync?.query(select, [2]).rows, [{ name: "two" }]);
			// A fragment renders to the same text whatever its value: the same statement.
			const two = await db.query(sql`select name from item where id = ${2}`);
			assert.deepEqual(two.rows, [{ name: "two" }]);
			assert.deepEqual((await db.query(select, [4])).rows, []);

			assert.equal(compiled(insert), compiles(3));
			assert.equal(compiled(select), compiles(5));
		} finally {
			await db.close();
		}
	});

	test("a write that returns rows is kept as one, and a transaction uses the same statements", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			await db.exec("create table item (id integer primary key, name text)");
			const insert = "insert into item (name) values (?) returning id, name";
			assert.deepEqual((await db.query(insert, ["a"])).rows, [
				{ id: 1, name: "a" },
			]);
			await db.transaction(async (tx) => {
				assert.deepEqual((await tx.query(insert, ["b"])).rows, [
					{ id: 2, name: "b" },
				]);
			});
			// A read-only one turns `query_only` on and off around itself, on the handle.
			await db.transaction(
				async (tx) => {
					await assert.rejects(tx.query(insert, ["never"]), /read-?only/i);
				},
				{ readOnly: true },
			);
			db.sync?.transaction((tx) => {
				const { rows, rowCount } = tx.query(insert, ["c"]);
				assert.deepEqual(rows, [{ id: 3, name: "c" }]);
				assert.equal(rowCount, 1);
			});
			assert.equal(compiled(insert), compiles(4));
		} finally {
			await db.close();
		}
	});

	test("the least recently used statement is dropped past statementCache", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite(":memory:", { statementCache: 2 });
		try {
			const [a, b, c] = ["select 1 as a", "select 2 as b", "select 3 as c"];
			// `c` goes in where `b` was: `a` was used after it.
			for (const text of [a, b, a, c, a, b]) await db.query(text);
			assert.deepEqual(
				[compiled(a), compiled(b), compiled(c)],
				KEEPS ? [1, 2, 1] : [3, 2, 1],
			);
		} finally {
			await db.close();
		}
	});

	test("openSqlite keeps 128 statements unless told otherwise", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			const texts = Array.from({ length: 129 }, (_, n) => `select ${n} as n`);
			for (const text of texts) await db.query(text);
			// The first of 129 went when the last came; the second is still there.
			for (const n of [128, 1, 0]) {
				assert.deepEqual((await db.query(texts[n] as string)).rows, [{ n }]);
			}
			assert.equal(compiled(texts[128] as string), compiles(2));
			assert.equal(compiled(texts[1] as string), compiles(2));
			assert.equal(compiled(texts[0] as string), 2);
		} finally {
			await db.close();
		}
	});

	test("createSqliteDriver keeps none unless asked: the handle is the host's", async (t) => {
		const compiled = countCompiles(t);
		const none = [
			createSqliteDriver(new DatabaseSync(":memory:")),
			createSqliteDriver(new DatabaseSync(":memory:"), {}),
			createSqliteDriver(new DatabaseSync(":memory:"), {
				statementCache: undefined,
			}),
			createSqliteDriver(new DatabaseSync(":memory:"), { statementCache: 0 }),
			openSqlite(":memory:", { statementCache: 0 }),
		];
		const kept = [
			createSqliteDriver(new DatabaseSync(":memory:"), { statementCache: 1 }),
			openSqlite(),
			openSqlite(":memory:", { busyTimeout: 10 }),
			openSqlite(":memory:", { statementCache: undefined }),
		];
		try {
			for (const db of none) {
				assert.deepEqual((await db.query("select 1 as none")).rows, [
					{ none: 1 },
				]);
				assert.deepEqual(db.sync?.query("select 1 as none").rows, [{ none: 1 }]);
			}
			for (const db of kept) {
				assert.deepEqual((await db.query("select 1 as kept")).rows, [
					{ kept: 1 },
				]);
				assert.deepEqual(db.sync?.query("select 1 as kept").rows, [{ kept: 1 }]);
			}
			assert.equal(compiled("select 1 as none"), none.length * 2);
			assert.equal(compiled("select 1 as kept"), kept.length * compiles(2));
		} finally {
			for (const db of [...none, ...kept]) await db.close();
		}
	});

	test("a query or a data change is kept, however it is written", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			await db.exec("create table item (id integer primary key, name text)");
			for (const text of [
				"select count(*) as n from item",
				"SELECT count(*) AS n FROM item",
				"  \n\t/* why */ -- and more\n select count(*) as n from item",
				"with named as (select 1 as n) select n from named",
				"values (1)",
				"insert into item (name) values ('a')",
				"replace into item (id, name) values (1, 'b')",
				"update item set name = 'c' where id = 1",
				"delete from item where id = 2",
				"with gone as (select 3 as id) delete from item where id in (select id from gone)",
			]) {
				await db.query(text);
				await db.query(text);
				assert.equal(compiled(text), compiles(2), text);
			}
		} finally {
			await db.close();
		}
	});

	test("a pragma, DDL and the rest are compiled for each call", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			for (const text of [
				"pragma user_version",
				"PRAGMA user_version = 3",
				"/* a pragma all the same */ pragma user_version",
				"create table if not exists item (id integer primary key)",
				"drop table if exists absent",
				"explain select 1",
				"analyze",
			]) {
				await db.query(text);
				await db.query(text);
				assert.equal(compiled(text), 2, text);
			}
		} finally {
			await db.close();
		}
	});

	test("anything that is not kept empties the cache: a pragma, DDL, a script, on either tier", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			const sync = db.sync;
			assert.ok(sync !== undefined);
			const text = "select 1 as still";
			const twice = async (): Promise<void> => {
				await db.query(text);
				assert.deepEqual(sync.query(text).rows, [{ still: 1 }]);
			};
			await twice();
			await db.query("pragma user_version");
			await twice();
			sync.query("create table item (id integer primary key)");
			await twice();
			await db.exec("insert into item (id) values (1)");
			await twice();
			sync.exec("delete from item");
			await twice();
			// One that failed too: part of a script may have run before the failure.
			await assert.rejects(db.exec("insert into item (id) values (2); nonsense"));
			await twice();
			// A kept statement empties nothing, and neither does a transaction's own
			// BEGIN and COMMIT.
			await db.transaction((tx) => tx.query("insert into item (id) values (3)"));
			await twice();
			// Fourteen runs. Kept, it was compiled at the start and after each of the five.
			assert.equal(compiled(text), KEEPS ? 6 : 14);
		} finally {
			await db.close();
		}
	});

	test("a text that is refused or does not compile is not kept", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			await db.exec("create table item (id integer primary key)");
			// More than one statement: refused each time, and none of it ran.
			const several =
				"insert into item (id) values (1); insert into item (id) values (2)";
			for (let n = 0; n < 2; n++) {
				await assert.rejects(db.query(several), TypeError);
			}
			assert.equal(compiled(several), 2);
			assert.deepEqual((await db.query("select count(*) as n from item")).rows, [
				{ n: 0 },
			]);

			// No such table yet: the failure is not kept either, so the text runs once
			// the table is there.
			const later = "select id from later";
			await assert.rejects(db.query(later), SqlError);
			await db.exec(
				"create table later (id integer); insert into later values (7)",
			);
			assert.deepEqual((await db.query(later)).rows, [{ id: 7 }]);
			assert.deepEqual((await db.query(later)).rows, [{ id: 7 }]);
			assert.equal(compiled(later), 1 + compiles(2));
		} finally {
			await db.close();
		}
	});
});

describe("sqlite/statement-cache: a kept statement answers as a new one would", () => {
	test("after the schema changed under it, through the driver", async () => {
		const db = openSqlite();
		try {
			await db.exec("create table item (a integer)");
			const select = "select * from item";
			const insert = "insert into item (a) values (?) returning *";
			assert.deepEqual((await db.query(insert, [1])).rows, [{ a: 1 }]);
			assert.deepEqual((await db.query(select)).rows, [{ a: 1 }]);

			// A column more: the first run after it has it, a write's `returning *` too.
			await db.exec("alter table item add column b text default 'x'");
			assert.deepEqual((await db.query(select)).rows, [{ a: 1, b: "x" }]);
			assert.deepEqual((await db.query(insert, [2])).rows, [{ a: 2, b: "x" }]);

			// A column less, changed by a statement rather than a script.
			await db.query("alter table item drop column a");
			assert.deepEqual((await db.query(select)).rows, [{ b: "x" }, { b: "x" }]);
			await db.query("alter table item rename column b to c");
			assert.deepEqual(db.sync?.query(select).rows, [{ c: "x" }, { c: "x" }]);

			// The table gone, the statement fails as a new one would; back, it reads it.
			await db.exec("drop table item");
			await assert.rejects(db.query(select), /no such table/);
			await db.exec("create table item (z integer); insert into item values (9)");
			assert.deepEqual((await db.query(select)).rows, [{ z: 9 }]);
		} finally {
			await db.close();
		}
	});

	test("after the schema changed on the host's handle, behind the driver", async () => {
		// Nothing tells the driver: SQLite recompiles the kept statement itself.
		const handle = new DatabaseSync(":memory:");
		const db = createSqliteDriver(handle, KEEPING);
		try {
			handle.exec("create table item (a integer); insert into item values (1)");
			const select = "select * from item";
			const insert = "insert into item (a) values (?) returning *";
			assert.deepEqual((await db.query(select)).rows, [{ a: 1 }]);
			assert.deepEqual((await db.query(insert, [2])).rows, [{ a: 2 }]);
			handle.exec("alter table item add column b text default 'x'");
			assert.deepEqual((await db.query(insert, [3])).rows, [{ a: 3, b: "x" }]);
			assert.deepEqual(db.sync?.query(select).rows, [
				{ a: 1, b: "x" },
				{ a: 2, b: "x" },
				{ a: 3, b: "x" },
			]);
			handle.exec("alter table item drop column a");
			assert.deepEqual((await db.query(select)).rows, [
				{ b: "x" },
				{ b: "x" },
				{ b: "x" },
			]);
		} finally {
			await db.close();
		}
	});

	test("after another handle changed the schema", async (t) => {
		if (!KEEPS) {
			// Nothing is kept here, and it is not the cache's to answer for: on this Node
			// a statement compiled for the call is misread too, once, right after
			// another connection changed the schema.
			t.skip(
				"this Node's node:sqlite misreads a recompiled statement, kept or not",
			);
			return;
		}
		await inTempDir(async (dir) => {
			const path = join(dir, "schema.db");
			const db = openSqlite(path);
			const other = openSqlite(path);
			try {
				await db.exec(
					"create table item (a integer); insert into item values (1)",
				);
				const select = "select * from item";
				assert.deepEqual((await db.query(select)).rows, [{ a: 1 }]);
				await other.exec("alter table item add column b text default 'x'");
				assert.deepEqual((await db.query(select)).rows, [{ a: 1, b: "x" }]);
				await other.exec("alter table item drop column a");
				assert.deepEqual((await db.query(select)).rows, [{ b: "x" }]);
			} finally {
				await db.close();
				await other.close();
			}
		});
	});

	test("after a table was made in front of the attached one its name meant", async () => {
		// An unqualified name is looked for in `main` first. SQLite does not recompile a
		// statement for a table that appears there, so the driver empties its cache
		// after anything that is not a kept statement.
		const db = openSqlite();
		try {
			await db.exec(
				"attach ':memory:' as aux;" +
					"create table aux.item (src text);" +
					"insert into aux.item (src) values ('aux')",
			);
			const read = "select src from item order by rowid";
			const write = "insert into item (src) values (?)";
			assert.deepEqual((await db.query(read)).rows, [{ src: "aux" }]);
			assert.equal((await db.query(write, ["first"])).rowCount, 1);

			// By a statement: the next write goes to `main`, not on to `aux`.
			await db.query("create table item (src text)");
			assert.equal((await db.query(write, ["second"])).rowCount, 1);
			assert.deepEqual((await db.query(read)).rows, [{ src: "second" }]);
			assert.deepEqual(
				(await db.query("select src from aux.item order by rowid")).rows,
				[{ src: "aux" }, { src: "first" }],
			);

			// Gone from `main`, the name means the attached one again; and by a script.
			await db.exec("drop table item");
			assert.deepEqual(db.sync?.query(read).rows, [
				{ src: "aux" },
				{ src: "first" },
			]);
			await db.exec(
				"create table item (src text); insert into item values ('again')",
			);
			assert.deepEqual((await db.query(read)).rows, [{ src: "again" }]);
			assert.equal((await db.query(write, ["third"])).rowCount, 1);
			assert.deepEqual(
				(await db.query("select count(*) as n from aux.item")).rows,
				[{ n: 2 }],
			);
		} finally {
			await db.close();
		}
	});

	test("after a pragma changed what it returns", async () => {
		// `count_changes` is deprecated, and where SQLite still has it a plain write
		// returns a row. Whatever this SQLite does, a kept statement does the same.
		const keeping = openSqlite();
		const plain = openSqlite(":memory:", { statementCache: 0 });
		try {
			const steps: [text: string, params?: unknown[]][] = [
				["create table item (id integer primary key, name text)"],
				["insert into item (id, name) values (?, ?)", [1, "a"]],
				["update item set name = ?", ["b"]],
				["pragma count_changes = on"],
				["insert into item (id, name) values (?, ?)", [2, "a"]],
				["update item set name = ?", ["c"]],
				["pragma count_changes = off"],
				["insert into item (id, name) values (?, ?)", [3, "a"]],
				["update item set name = ?", ["d"]],
			];
			for (const [text, params] of steps) {
				assert.deepEqual(
					await keeping.query(text, params),
					await plain.query(text, params),
					text,
				);
			}
		} finally {
			await keeping.close();
			await plain.close();
		}
	});

	test("after a setting it was compiled under changed on the host's handle", async () => {
		const handle = new DatabaseSync(":memory:", {
			enableForeignKeyConstraints: false,
		});
		const db = createSqliteDriver(handle, KEEPING);
		try {
			await db.exec(
				"create table parent (id integer primary key);" +
					"create table child (parent integer references parent (id))",
			);
			const insert = "insert into child (parent) values (?)";
			// Foreign keys are off: an orphan goes in.
			assert.equal((await db.query(insert, [1])).rowCount, 1);
			handle.exec("pragma foreign_keys = on");
			await assert.rejects(db.query(insert, [2]), ForeignKeyViolationError);
			handle.exec("pragma foreign_keys = off");
			assert.equal((await db.query(insert, [3])).rowCount, 1);

			// A function the host replaces is the one a kept statement calls.
			handle.function("answer", () => 1);
			assert.deepEqual((await db.query("select answer() as n")).rows, [{ n: 1 }]);
			handle.function("answer", () => 2);
			assert.deepEqual((await db.query("select answer() as n")).rows, [{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	test("after the host installed an authorizer", async () => {
		const handle = new DatabaseSync(":memory:");
		const db = createSqliteDriver(handle, KEEPING);
		try {
			await db.exec(
				"create table secret (v text); insert into secret values ('s')",
			);
			const read = "select v from secret";
			assert.deepEqual((await db.query(read)).rows, [{ v: "s" }]);
			assert.deepEqual((await db.query(read)).rows, [{ v: "s" }]);
			handle.setAuthorizer((action, table) =>
				action === constants.SQLITE_READ && table === "secret"
					? constants.SQLITE_DENY
					: constants.SQLITE_OK,
			);
			await assert.rejects(db.query(read), /prohibited/);
			handle.setAuthorizer(null);
			assert.deepEqual((await db.query(read)).rows, [{ v: "s" }]);
		} finally {
			await db.close();
		}
	});

	test("but not after an authorizer changed its answer: why a host's handle keeps none unless asked", async () => {
		// SQLite asks an authorizer while it compiles a statement, and recompiles for a
		// new authorizer, not for a new answer. A kept statement was asked once.
		const read = "select v from secret";
		const over = (options?: SqliteDriverOptions) => {
			const handle = new DatabaseSync(":memory:");
			handle.exec("create table secret (v text); insert into secret values ('s')");
			let role = "admin";
			handle.setAuthorizer((action, table) =>
				action === constants.SQLITE_READ && table === "secret" && role !== "admin"
					? constants.SQLITE_DENY
					: constants.SQLITE_OK,
			);
			return {
				db: createSqliteDriver(handle, options),
				demote(): void {
					role = "guest";
				},
			};
		};
		const byDefault = over();
		const keeping = over(KEEPING);
		try {
			for (const { db, demote } of [byDefault, keeping]) {
				assert.deepEqual((await db.query(read)).rows, [{ v: "s" }]);
				demote();
			}
			await assert.rejects(byDefault.db.query(read), /prohibited/);
			if (KEEPS) {
				assert.deepEqual((await keeping.db.query(read)).rows, [{ v: "s" }]);
			} else {
				await assert.rejects(keeping.db.query(read), /prohibited/);
			}
			// A text the driver has not kept is compiled, and so asked about.
			await assert.rejects(
				keeping.db.query("select v from secret where v is not null"),
				/prohibited/,
			);
		} finally {
			await byDefault.db.close();
			await keeping.db.close();
		}
	});

	test("a pragma reads what is set now, and sets it each time", async () => {
		const db = openSqlite(":memory:", { busyTimeout: 0 });
		try {
			const read = async (): Promise<unknown> =>
				Object.values((await db.query("pragma busy_timeout")).rows[0] ?? {})[0];
			assert.equal(await read(), 0);
			await db.query("pragma busy_timeout = 250");
			assert.equal(await read(), 250);
			await db.query("pragma busy_timeout = 20");
			assert.equal(await read(), 20);
			// The same text again sets it again.
			await db.query("pragma busy_timeout = 250");
			assert.equal(await read(), 250);
		} finally {
			await db.close();
		}
	});

	test("after it failed on its values, and with fewer values than the run before", async (t) => {
		const compiled = countCompiles(t);
		const db = openSqlite();
		try {
			await db.exec("create table item (name text unique)");
			const insert = "insert into item (name) values (?)";
			assert.equal((await db.query(insert, ["a"])).rowCount, 1);
			await assert.rejects(db.query(insert, ["a"]), UniqueViolationError);
			assert.equal((await db.query(insert, ["b"])).rowCount, 1);
			assert.equal(compiled(insert), compiles(3));

			// Nothing bound is left from the run before: a value not given is NULL.
			const pair = "select ? as a, ? as b";
			assert.deepEqual((await db.query(pair, [1, 2])).rows, [{ a: 1, b: 2 }]);
			assert.deepEqual((await db.query(pair, [3])).rows, [{ a: 3, b: null }]);
			assert.deepEqual((await db.query(pair)).rows, [{ a: null, b: null }]);
		} finally {
			await db.close();
		}
	});

	test("rows of one run are not the rows of the next", async () => {
		const db = openSqlite();
		try {
			const text = "select 1 as one";
			const first = (await db.query<{ one: number }>(text)).rows;
			(first[0] as { one: number }).one = 99;
			first.push({ one: 100 });
			const second = (await db.query(text)).rows;
			assert.deepEqual(second, [{ one: 1 }]);
			assert.equal(Object.getPrototypeOf(second[0]), Object.prototype);
		} finally {
			await db.close();
		}
	});

	test("rows are objects on a handle opened to answer arrays, on every run", async () => {
		const db = createSqliteDriver(
			new DatabaseSync(":memory:", { returnArrays: true }),
			KEEPING,
		);
		try {
			for (let n = 0; n < 3; n++) {
				assert.deepEqual((await db.query("select 1 as one, 'two' as two")).rows, [
					{ one: 1, two: "two" },
				]);
			}
		} finally {
			await db.close();
		}
	});

	test("step for step as a driver that keeps none, through schema changes and failures", async () => {
		// Two statements kept: with thirteen in turn, one is dropped and compiled again
		// at almost every step, between runs of the ones that stay.
		const keeping = openSqlite(":memory:", { statementCache: 2 });
		const plain = openSqlite(":memory:", { statementCache: 0 });
		/** What a statement answered, or how it failed. */
		const answer = async (db: Driver, text: string, params: unknown[]) => {
			try {
				const { rows, rowCount } = await db.query(text, params);
				return { rows, rowCount };
			} catch (error) {
				assert.ok(error instanceof SqlError, String(error));
				return { failed: error.kind, message: error.message };
			}
		};
		const statements: [text: string, params: (n: number) => unknown[]][] = [
			["insert into item (id, name) values (?, ?)", (n) => [n % 9, `n${n}`]],
			["insert into item (name) values (?) returning *", (n) => [`r${n}`]],
			["select * from item order by id", () => []],
			["select count(*) as n from item", () => []],
			[
				"update item set name = ? where id = ? returning *",
				(n) => [`u${n}`, n % 9],
			],
			["delete from item where id = ?", (n) => [n % 5]],
			["alter table item add column extra text default 'e'", () => []],
			["alter table item drop column extra", () => []],
			["select extra from item order by id", () => []],
			[
				"create table if not exists child (item integer references item (id))",
				() => [],
			],
			["drop table if exists child", () => []],
			["insert into child (item) values (?) returning *", (n) => [n % 9]],
			["select * from child order by item", () => []],
		];
		try {
			for (const db of [keeping, plain]) {
				await db.exec("create table item (id integer primary key, name text)");
				await db.exec("pragma foreign_keys = on");
			}
			// A fixed sequence, so a failure names a step that fails again.
			let seed = 20261119;
			const seen = new Set<string>();
			for (let step = 0; step < 800; step++) {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				const [text, params] = statements[seed % statements.length] ?? [
					"",
					() => [],
				];
				const expected = await answer(plain, text, params(step));
				const actual = await answer(keeping, text, params(step));
				assert.deepEqual(actual, expected, `step ${step}: ${text}`);
				seen.add(`${text}: ${"failed" in expected ? expected.failed : "ok"}`);
			}
			// The sequence is worth its name only if it met the failures and the changes.
			for (const met of [
				"insert into item (id, name) values (?, ?): unique",
				"insert into child (item) values (?) returning *: foreign_key",
				"alter table item add column extra text default 'e': ok",
				"alter table item drop column extra: ok",
				"select extra from item order by id: ok",
				"select extra from item order by id: unknown",
				"select * from child order by item: ok",
				"select * from child order by item: unknown",
			]) {
				assert.ok(seen.has(met), `the sequence never met "${met}"`);
			}
		} finally {
			await keeping.close();
			await plain.close();
		}
	});

	test("when a function of the host's sends the running statement's text again", async (t) => {
		const compiled = countCompiles(t);
		const handle = new DatabaseSync(":memory:");
		const db = createSqliteDriver(handle, KEEPING);
		try {
			const sync = db.sync;
			assert.ok(sync !== undefined);
			sync.exec("create table item (id integer primary key)");
			sync.exec("insert into item (id) values (1), (2), (3)");
			// One statement cannot run twice at once: node:sqlite refuses it, and before
			// it did, the statement started over and never ended.
			const text = "select id, below(id) as n from item where id <= ? order by id";
			let inside = false;
			handle.function("below", (id) => {
				if (inside) return -1;
				inside = true;
				try {
					return sync.query(text, [id]).rows.length;
				} finally {
					inside = false;
				}
			});
			const expected = [
				{ id: 1, n: 1 },
				{ id: 2, n: 2 },
				{ id: 3, n: 3 },
			];
			// The first run compiles and keeps it; the second finds it kept and running.
			assert.deepEqual(sync.query(text, [3]).rows, expected);
			assert.deepEqual(sync.query(text, [3]).rows, expected);
			assert.deepEqual((await db.query(text, [3])).rows, expected);
			// Each of the 9 calls from inside compiled its own; the 3 from outside share one.
			assert.equal(compiled(text), 9 + compiles(3));
		} finally {
			await db.close();
		}
	});
});

describe("sqlite/statement-cache: the handle closed under the driver", () => {
	test("a handle closed and opened again has its statements compiled again, and each runs once", async (t) => {
		await inTempDir(async (dir) => {
			const compiled = countCompiles(t);
			const handle = new DatabaseSync(join(dir, "reopened.db"));
			const db = createSqliteDriver(handle, KEEPING);
			try {
				await db.exec("create table item (v integer)");
				const insert = "insert into item (v) values (?)";
				const select = "select count(*) as n from item";
				await db.query(insert, [1]);
				await db.query(insert, [2]);
				assert.deepEqual((await db.query(select)).rows, [{ n: 2 }]);

				// Closing a handle finalizes every statement compiled on it. Nothing is
				// asked of the driver meanwhile: the next call finds its statement so.
				handle.close();
				handle.open();
				assert.equal((await db.query(insert, [3])).rowCount, 1);
				assert.equal((await db.query(insert, [4])).rowCount, 1);
				// Four rows: the write that found its statement finalized ran once.
				assert.deepEqual((await db.query(select)).rows, [{ n: 4 }]);
				assert.deepEqual(db.sync?.query(select).rows, [{ n: 4 }]);

				// Closed and left so, a kept text is refused as any other is.
				handle.close();
				await assert.rejects(db.query(insert, [5]), /not open/);
				await assert.rejects(db.query(select), /not open/);
				await assert.rejects(db.query("select 2 as never"), /not open/);

				// Kept, compiled again once the handle was back, and asked for once more
				// while it was closed.
				assert.equal(compiled(insert), compiles(2) + compiles(2) + 1);
				assert.equal(compiled(select), 1 + compiles(2) + 1);
			} finally {
				await db.close();
			}
		});
	});

	test("close() ends a kept statement as it ends any other", async () => {
		const handle = new DatabaseSync(":memory:");
		const db = createSqliteDriver(handle, KEEPING);
		const text = "select 1 as one";
		await db.query(text);
		await db.query(text);
		await db.close();
		assert.equal(handle.isOpen, false);
		await assert.rejects(db.query(text), /not open/);
		await assert.rejects(db.query("select 2 as never"), /not open/);
		assert.throws(() => db.sync?.query(text), /not open/);
	});
});

describe("sqlite/statement-cache: the option", () => {
	test("a statementCache that is not a whole number from 0 is a TypeError, before a file is opened", () => {
		const dir = mkdtempSync(join(tmpdir(), "sqlkit-sqlite-cache-"));
		const path = join(dir, "never.db");
		const handle = new DatabaseSync(":memory:");
		try {
			for (const bad of [
				-1,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				"8",
				null,
			]) {
				assert.throws(
					() => openSqlite(path, { statementCache: bad as number }),
					(error: unknown) =>
						error instanceof TypeError &&
						/^openSqlite: statementCache /.test(error.message),
					String(bad),
				);
				assert.throws(
					() => createSqliteDriver(handle, { statementCache: bad as number }),
					(error: unknown) =>
						error instanceof TypeError &&
						/^createSqliteDriver: statementCache /.test(error.message),
					String(bad),
				);
			}
			assert.equal(existsSync(path), false, "the refused call opened the file");
			// The handle was refused, not closed: it is the host's.
			assert.equal(handle.isOpen, true);
		} finally {
			handle.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
