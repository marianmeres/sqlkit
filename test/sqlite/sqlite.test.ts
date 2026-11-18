// The node:sqlite adapter's own behaviour (plan doc 02 #2, #3): what `openSqlite` sets on
// the database it opens, what `createSqliteDriver` leaves alone on one the host opened
// (D23), `close()` (D13), its sync tier being the host's handle, and a read-only
// transaction, on either tier, beside another handle's write.
//
// Adapter-specific, not a conformance body: each case is about the handle node:sqlite
// gives (its pragmas, its open options, a second handle on the same file), which no other
// adapter has. The contract's rules are in test/conformance/driver.ts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { Driver } from "../../src/mod.ts";
import { createSqliteDriver, openSqlite } from "../../src/sqlite/mod.ts";

/** A temporary directory for database files, removed after `fn`. */
async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "sqlkit-sqlite-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The one value a pragma reads as. */
async function pragma(db: Driver, name: string): Promise<unknown> {
	const { rows } = await db.query(`pragma ${name}`);
	return Object.values(rows[0] ?? {})[0];
}

async function count(db: Driver): Promise<number> {
	const { rows } = await db.query<{ n: number }>("select count(*) as n from t");
	return Number(rows[0]?.n);
}

describe("sqlite/adapter: openSqlite", () => {
	test("waits 5000 ms on a busy database by default; busyTimeout changes it", async () => {
		const plain = openSqlite();
		const custom = openSqlite(":memory:", { busyTimeout: 150 });
		const zero = openSqlite(":memory:", { busyTimeout: 0 });
		try {
			assert.equal(await pragma(plain, "busy_timeout"), 5_000);
			assert.equal(await pragma(custom, "busy_timeout"), 150);
			assert.equal(await pragma(zero, "busy_timeout"), 0);
		} finally {
			await plain.close();
			await custom.close();
			await zero.close();
		}
	});

	test("a busyTimeout that is not a whole number from 0 is a TypeError", () => {
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100", null]) {
			assert.throws(
				() => openSqlite(":memory:", { busyTimeout: bad as number }),
				(error: unknown) =>
					error instanceof TypeError && /busyTimeout/.test(error.message),
				String(bad),
			);
		}
	});

	test("the busy timeout is the wait SQLite does on a second handle", async () => {
		await inTempDir(async (dir) => {
			const path = join(dir, "busy.db");
			const holder = openSqlite(path);
			const waiter = openSqlite(path, { busyTimeout: 150 });
			try {
				await holder.query("create table t (id text primary key)");
				await holder.transaction(async () => {
					// The handle is synchronous, so the wait blocks the thread.
					const started = performance.now();
					await assert.rejects(
						waiter.query("insert into t (id) values ('w')"),
						/locked|busy/i,
					);
					const waited = performance.now() - started;
					assert.ok(waited >= 100, `gave up after ${waited.toFixed(0)} ms`);
				});
				// Free again, the same statement goes through.
				await waiter.query("insert into t (id) values ('w')");
				assert.equal(await count(holder), 1);
			} finally {
				await holder.close();
				await waiter.close();
			}
		});
	});

	test("a file is opened in WAL mode; an in-memory database is not", async () => {
		await inTempDir(async (dir) => {
			const file = openSqlite(join(dir, "wal.db"));
			const memory = openSqlite();
			const fallback = openSqlite(":memory:");
			try {
				assert.equal(await pragma(file, "journal_mode"), "wal");
				assert.equal(await pragma(memory, "journal_mode"), "memory");
				assert.equal(await pragma(fallback, "journal_mode"), "memory");
			} finally {
				await file.close();
				await memory.close();
				await fallback.close();
			}
		});
	});

	test("answers a node:sqlite driver: one connection, a sync tier, no cross-process lock", async () => {
		const db = openSqlite();
		try {
			assert.equal(db.dialect, "sqlite");
			assert.equal(db.adapter, "node:sqlite");
			assert.deepEqual(db.capabilities, {
				sync: true,
				concurrentWriters: false,
				crossProcessLock: false,
			});
			assert.ok(db.sync !== undefined);
		} finally {
			await db.close();
		}
	});
});

describe("sqlite/adapter: createSqliteDriver", () => {
	test("the driver has a sync tier over the host's handle", async () => {
		const handle = new DatabaseSync(":memory:");
		const db = createSqliteDriver(handle);
		try {
			assert.equal(db.capabilities.sync, true);
			assert.ok(db.sync !== undefined);
			db.sync.exec("create table t (id text primary key)");
			assert.equal(db.sync.query("insert into t (id) values ('a')").rowCount, 1);
			// The same handle, not a second connection to the database.
			assert.equal(handle.prepare("select id from t").get()?.id, "a");
		} finally {
			await db.close();
		}
	});

	test("sets nothing on a handle the host opened", async () => {
		await inTempDir(async (dir) => {
			const handle = new DatabaseSync(join(dir, "host.db"));
			const db = createSqliteDriver(handle);
			try {
				assert.equal(await pragma(db, "busy_timeout"), 0);
				assert.equal(await pragma(db, "journal_mode"), "delete");
				// A read-only transaction leaves a handle the host made query-only so.
				handle.exec("pragma query_only = on");
				assert.equal(
					await db.transaction(() => pragma(db, "query_only"), {
						readOnly: true,
					}),
					1,
				);
				assert.equal(await pragma(db, "query_only"), 1);
				handle.exec("pragma query_only = off");
				// And one the host left writable writes again once it is over.
				await db.query("create table t (id text primary key)");
				await db.transaction(async () => undefined, { readOnly: true });
				assert.equal(await pragma(db, "query_only"), 0);
				await db.query("insert into t (id) values ('a')");
			} finally {
				await db.close();
			}
		});
	});

	test("rows are objects even on a handle opened to answer arrays", async () => {
		const handle = new DatabaseSync(":memory:", { returnArrays: true });
		const db = createSqliteDriver(handle);
		try {
			const { rows } = await db.query("select 1 as one, 'two' as two");
			assert.deepEqual(rows, [{ one: 1, two: "two" }]);
			assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
		} finally {
			await db.close();
		}
	});

	test("a read-only transaction refuses a write on a handle that reads bigints", async () => {
		const handle = new DatabaseSync(":memory:", { readBigInts: true });
		const db = createSqliteDriver(handle);
		try {
			await db.query("create table t (id text primary key)");
			await assert.rejects(
				db.transaction((tx) => tx.query("insert into t (id) values ('a')"), {
					readOnly: true,
				}),
				/read-?only/i,
			);
			assert.deepEqual((await db.query("select count(*) as n from t")).rows, [
				{ n: 0n },
			]);
			assert.equal(
				(await db.query("insert into t (id) values ('b')")).rowCount,
				1,
				"the handle stayed query-only after the transaction",
			);
		} finally {
			await db.close();
		}
	});

	test("close() closes the host's handle, and is idempotent", async () => {
		const handle = new DatabaseSync(":memory:");
		const db = createSqliteDriver(handle);
		const first = db.close();
		assert.equal(db.close(), first, "a second close() answered another promise");
		await first;
		assert.equal(handle.isOpen, false);
		await db.close();
		// A statement after close() is refused by the closed handle, with a promise.
		await assert.rejects(db.query("select 1"), /not open/);

		// A handle the host already closed is not closed twice.
		const closedFirst = new DatabaseSync(":memory:");
		const other = createSqliteDriver(closedFirst);
		closedFirst.close();
		await other.close();
	});

	test("close() inside a transaction is refused rather than waiting for itself", async () => {
		const db = openSqlite();
		try {
			await db.transaction(async (tx) => {
				await assert.rejects(tx.close(), TypeError);
			});
			assert.deepEqual((await db.query("select 1 as one")).rows, [{ one: 1 }]);
		} finally {
			await db.close();
		}
	});

	test("anything but a DatabaseSync is a TypeError", () => {
		for (const bad of [
			undefined,
			null,
			":memory:",
			{},
			{ prepare: () => undefined },
		]) {
			assert.throws(
				() => createSqliteDriver(bad as unknown as DatabaseSync),
				TypeError,
				String(bad),
			);
		}
	});
});

describe("sqlite/adapter: read-only transactions", () => {
	test("a read-only transaction takes no write lock, and reads one snapshot", async () => {
		// A dump beside a live writer: two handles on one file. A `BEGIN IMMEDIATE` reader
		// would hold the write lock, and the writer would fail after its busy timeout; the
		// deferred `BEGIN` of a read-only one does not.
		await inTempDir(async (dir) => {
			const path = join(dir, "read-only.db");
			const reader = openSqlite(path);
			const writer = openSqlite(path, { busyTimeout: 150 });
			try {
				await reader.query("create table t (id text primary key)");
				const [before, after] = await reader.transaction(
					async () => {
						const first = await count(reader);
						await writer.query("insert into t (id) values ('w')");
						return [first, await count(reader)];
					},
					{ readOnly: true },
				);
				assert.deepEqual(
					[before, after],
					[0, 0],
					"the reader saw a later commit",
				);
				assert.equal(await count(reader), 1);
			} finally {
				await reader.close();
				await writer.close();
			}
		});
	});

	test("a read-only sync transaction takes no write lock either", async () => {
		await inTempDir(async (dir) => {
			const path = join(dir, "read-only-sync.db");
			const reader = openSqlite(path);
			const writer = openSqlite(path, { busyTimeout: 150 });
			try {
				const sync = reader.sync;
				assert.ok(sync !== undefined);
				sync.exec("create table t (id text primary key)");
				const seen = sync.transaction(
					(tx) => {
						const first = Number(
							tx.query("select count(*) as n from t").rows[0]?.n,
						);
						// Another handle, synchronously: it would fail after 150 ms if the
						// reader held the write lock.
						writer.sync?.query("insert into t (id) values ('w')");
						return [
							first,
							Number(tx.query("select count(*) as n from t").rows[0]?.n),
						];
					},
					{ readOnly: true },
				);
				assert.deepEqual(seen, [0, 0], "the reader saw a later commit");
				assert.equal(await count(reader), 1);
			} finally {
				await reader.close();
				await writer.close();
			}
		});
	});
});
