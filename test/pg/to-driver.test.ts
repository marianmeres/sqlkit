// `toPgDriver` (backlog T35): the driver for whatever a library was handed, a pool, a
// client or a `Driver`, and one driver per pool and per client.
//
// Adapter-specific by necessity: it is about the two objects node-postgres has, what tells
// them apart, and what a second driver over the same one does (the `error` event both
// listen to, the one session both send on). The last two are the reasons the driver is
// kept, so each is shown on two drivers the factory built, where it goes wrong, and on the
// one `toPgDriver` keeps, where it does not.
//
// Most cases connect to nothing: the conversion sends no statement.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import pg from "pg";
import type { Driver } from "../../src/mod.ts";
import {
	createPgClientDriver,
	createPgDriver,
	type PgDb,
	type PgPoolLike,
	type PgStandaloneClientLike,
	toPgDriver,
} from "../../src/pg/mod.ts";
import { openSqlite } from "../../src/sqlite/mod.ts";
import { testPgConfig } from "../_env.ts";
import { connectedClient } from "./_fixture.ts";

/** A promise and the function that resolves it: a gate a case opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** An error that is a `TypeError`, whose message matches `pattern`. */
function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

/** Let what was scheduled run: a warning is emitted on a later tick. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

/** The warnings the process emits while `fn` runs, by message. */
async function warningsDuring(fn: () => void): Promise<string[]> {
	const seen: string[] = [];
	const listen = (warning: Error): void => {
		seen.push(warning.message);
	};
	process.on("warning", listen);
	try {
		fn();
		await settle();
	} finally {
		process.off("warning", listen);
	}
	return seen;
}

const nothing = (): void => {};

/** A driver as plain as the contract allows: built by no factory of this package. */
function plainDriver(dialect: string): Record<string, unknown> {
	return {
		dialect,
		adapter: "plain",
		capabilities: { sync: false, concurrentWriters: true, crossProcessLock: true },
		query: nothing,
		exec: nothing,
		transaction: nothing,
		exclusive: nothing,
		savepoint: nothing,
		close: nothing,
	};
}

describe("pg/to-driver: what it hands back", () => {
	test("a pool gets the pool driver, and it runs", async () => {
		const pool = new pg.Pool({ ...testPgConfig(), max: 2 });
		const db = toPgDriver(pool);
		try {
			assert.equal(db.adapter, "pg");
			assert.equal(db.capabilities.concurrentWriters, true);
			assert.deepEqual((await db.query("select 1 as one")).rows, [{ one: 1 }]);
			// A transaction is one connection, as on the factory's driver.
			const pids = await db.transaction(async (tx) => [
				(await tx.query("select pg_backend_pid() as pid")).rows[0]?.pid,
				(await db.query("select pg_backend_pid() as pid")).rows[0]?.pid,
			]);
			assert.equal(typeof pids[0], "number");
			assert.equal(pids[0], pids[1]);
		} finally {
			await db.close();
		}
		assert.equal(pool.ended, true);
	});

	test("a client gets the client driver, and it runs", async () => {
		const client = await connectedClient();
		const db = toPgDriver(client);
		try {
			assert.equal(db.adapter, "pg-client");
			assert.equal(db.capabilities.concurrentWriters, false);
			assert.deepEqual((await db.query("select 1 as one")).rows, [{ one: 1 }]);
		} finally {
			await db.close();
		}
	});

	test("a Driver comes back as it is, whoever built it, and adds no listener", async () => {
		const pool = new pg.Pool(testPgConfig());
		const built = createPgDriver(pool);
		try {
			assert.equal(toPgDriver(built), built);
			assert.equal(pool.listenerCount("error"), 1);
			// Not this package's object: a driver is one by its shape.
			const plain = plainDriver("pg") as unknown as Driver;
			assert.equal(toPgDriver(plain), plain);
		} finally {
			await built.close();
		}
	});

	test("a pool is told by its count, or by having no query(); a client by query() and no count", () => {
		const listening = { on: nothing, listenerCount: () => 1, end: async () => {} };
		const query = async () => ({ rows: [], rowCount: 0, command: "SELECT" });
		const connect = async () => ({ query, release: nothing });

		// What `PgPoolLike` declares, and no more: nothing a client could be.
		const pool: PgPoolLike = { ...listening, connect };
		assert.equal(toPgDriver(pool).adapter, "pg");
		// node-postgres's pool has `query` as well, and counts its connections.
		const counting = { ...listening, connect, query, totalCount: 0 };
		assert.equal(toPgDriver(counting).adapter, "pg");
		// What `PgStandaloneClientLike` declares; node-postgres's client has `connect` too.
		const client: PgStandaloneClientLike = { ...listening, query };
		assert.equal(toPgDriver(client).adapter, "pg-client");
		assert.equal(toPgDriver({ ...listening, query, connect }).adapter, "pg-client");
	});
});

describe("pg/to-driver: one driver per pool, and per client", () => {
	test("the same object gets the same driver, and one listener; another object, another driver", async () => {
		const pool = new pg.Pool(testPgConfig());
		const other = new pg.Pool(testPgConfig());
		const client = new pg.Client(testPgConfig());
		try {
			const db = toPgDriver(pool);
			assert.equal(toPgDriver(pool), db);
			assert.equal(toPgDriver(pool), db);
			assert.equal(pool.listenerCount("error"), 1);
			assert.notEqual(toPgDriver(other), db);

			const one = toPgDriver(client);
			assert.equal(toPgDriver(client), one);
			assert.equal(client.listenerCount("error"), 1);

			// The factory builds one per call, each with a listener of its own.
			assert.notEqual(createPgDriver(pool), db);
			assert.equal(pool.listenerCount("error"), 2);
		} finally {
			await pool.end();
			await other.end();
			await client.end();
		}
	});

	test("two drivers over one pool keep each other quiet about its error; the one kept reports it", async () => {
		// Nothing connects: no statement is sent here.
		const doubled = new pg.Pool(testPgConfig());
		const single = new pg.Pool(testPgConfig());
		try {
			// Each listener takes the other for the host's, and leaves the report to it.
			createPgDriver(doubled);
			createPgDriver(doubled);
			assert.deepEqual(
				await warningsDuring(() => doubled.emit("error", new Error("dropped"))),
				[],
			);

			toPgDriver(single);
			toPgDriver(single);
			const warned = once(process, "warning");
			single.emit("error", new Error("dropped"));
			const [warning] = (await warned) as [Error];
			assert.match(warning.message, /idle pooled connection failed.*dropped/);
		} finally {
			await doubled.end();
			await single.end();
		}
	});

	test("two drivers over one client run into each other's transaction; the one kept gives each its turn", async () => {
		const boom = new Error("boom");
		/**
		 * A transaction through `a` that stays open while `b`, from outside it, inserts
		 * `other`, and is then rolled back. Whether `other` was written before the
		 * transaction ended, and whether it is still there afterwards.
		 *
		 * `inside` says which is expected, because the two are waited for differently:
		 * a statement that runs inside the open transaction is awaited there (one that
		 * is held back would never settle, and the case would time out), and one that is
		 * held back is given time to run, and seen not to have.
		 */
		const during = async (
			a: Driver,
			b: Driver,
			inside: boolean,
		): Promise<{ ranInside: boolean; kept: boolean }> => {
			await a.exec("create temp table to_driver_t (id text primary key)");
			const entered = gate();
			const holds = gate();
			const transaction = a.transaction(async (tx) => {
				await tx.query("insert into to_driver_t (id) values ('inside')");
				entered.open();
				await holds.opened;
				throw boom;
			});
			await entered.opened;
			let written = false;
			const other = b
				.query("insert into to_driver_t (id) values ('other')")
				.then(() => {
					written = true;
				});
			if (inside) {
				await other;
			} else {
				// A connection of its own, made and used: time enough for `other` to
				// have run, had nothing held it back.
				const aside = await connectedClient();
				try {
					await aside.query("select pg_sleep(0.1)");
				} finally {
					await aside.end();
				}
			}
			const ranInside = written;
			holds.open();
			await assert.rejects(transaction, (error) => error === boom);
			await other;
			const { rows } = await a.query("select id from to_driver_t");
			return { ranInside, kept: rows.length === 1 && rows[0]?.id === "other" };
		};

		// Two drivers the factory built: `b` knows nothing of the transaction `a` has
		// open on the one session, sends its statement into it, and loses it to the
		// rollback.
		const shared = await connectedClient();
		try {
			const outcome = await during(
				createPgClientDriver(shared),
				createPgClientDriver(shared),
				true,
			);
			assert.deepEqual(outcome, { ranInside: true, kept: false });
		} finally {
			await shared.end();
		}

		// The driver `toPgDriver` keeps: the statement waits for the transaction to end,
		// and is not part of it.
		const client = await connectedClient();
		try {
			const outcome = await during(toPgDriver(client), toPgDriver(client), false);
			assert.deepEqual(outcome, { ranInside: false, kept: true });
		} finally {
			await client.end();
		}
	});
});

describe("pg/to-driver: what it refuses", () => {
	test("what is no pool, no client and no driver", () => {
		for (const nothingOfThose of [
			undefined,
			null,
			"postgres://…",
			1,
			true,
			nothing,
		]) {
			assert.throws(
				() => toPgDriver(nothingOfThose as unknown as PgDb),
				typeError(
					/takes a node-postgres pg\.Pool, a pg\.Client or a Driver.*, got /,
				),
				String(nothingOfThose),
			);
		}
		const shapes: Record<string, unknown>[] = [
			{},
			[] as unknown as Record<string, unknown>,
			{ query: nothing },
			{ connect: nothing },
			// It counts connections, and has nothing a pool is asked for.
			{ totalCount: 1, query: nothing, end: nothing },
			// A client's methods, but for the events the driver listens to.
			{ query: nothing, end: nothing },
		];
		for (const shape of shapes) {
			assert.throws(
				() => toPgDriver(shape as unknown as PgDb),
				typeError(/got an object that is none of them/),
				JSON.stringify(Object.keys(shape)),
			);
		}
	});

	test("a Driver of another dialect, by its name", async () => {
		const sqlite = openSqlite();
		try {
			assert.throws(
				() => toPgDriver(sqlite),
				typeError(
					/takes a Driver of the pg dialect, got "sqlite" \(node:sqlite\)/,
				),
			);
		} finally {
			await sqlite.close();
		}
	});

	test("a Driver that lacks a member of the contract, naming it", () => {
		// What a driver built before `savepoint` was added looks like.
		const old = plainDriver("pg");
		delete old.savepoint;
		assert.throws(
			() => toPgDriver(old as unknown as PgDb),
			typeError(
				/as this version of the package has it: this one has no savepoint\(\)$/,
			),
		);
		const less = plainDriver("pg");
		delete less.exclusive;
		delete less.close;
		assert.throws(
			() => toPgDriver(less as unknown as PgDb),
			typeError(/this one has no exclusive\(\), no close\(\)$/),
		);
		// A dialect this version does not know is a member it lacks, not another dialect.
		assert.throws(
			() => toPgDriver(plainDriver("mysql") as unknown as PgDb),
			typeError(/this one has no dialect of "pg" or "sqlite"$/),
		);
	});
});
