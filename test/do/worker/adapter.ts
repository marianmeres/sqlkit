// The Durable Object of the Durable Objects adapter's own suite (`test/do/adapter.test.ts`).
// One handler per check; each asserts inside workerd with `node:assert/strict` and answers
// `null`, or throws what failed. Every call reaches a fresh object, an empty database.

import type { DurableObjectState } from "cloudflare:workers";
import { DurableObject } from "cloudflare:workers";
import assert from "node:assert/strict";
import { createDoDriver } from "../../../src/do/mod.ts";
import {
	type Driver,
	ReadOnlyError,
	SqlError,
	type SyncDriver,
	sql,
} from "../../../src/mod.ts";

type Check = (ctx: DurableObjectState) => void | Promise<void>;

/** A driver over the object's storage, with a table `t` of `rows` rows. */
async function seeded(ctx: DurableObjectState, rows = 0): Promise<Driver> {
	const db = createDoDriver(ctx.storage);
	await db.exec("create table t (id integer primary key, grp text, label text)");
	for (let i = 0; i < rows; i++) {
		await db.query(
			sql`insert into t (grp, label) values (${`g${i % 3}`}, ${`l${(i * 7) % 11}`})`,
		);
	}
	return db;
}

function tierOf(db: Driver): SyncDriver {
	assert.ok(db.sync !== undefined, "the adapter has no sync tier");
	return db.sync;
}

async function count(db: Driver): Promise<number> {
	const { rows } = await db.query<{ c: number }>("select count(*) as c from t");
	return Number(rows[0]?.c);
}

/** A `ReadOnlyError` as the adapter raises one: SQLite's own code, 8. */
function readOnly(error: unknown): boolean {
	return (
		error instanceof ReadOnlyError && error.kind === "read_only" && error.code === "8"
	);
}

/** Reads that sort, group, dedupe or number rows: none of them reports a row written. */
const READS = [
	"select * from t",
	"select * from t order by label",
	"select * from t order by label desc limit 3",
	"select grp, count(*) as n from t group by grp",
	"select label, count(*) as n from t group by label order by n desc",
	"select distinct label from t",
	"select grp from t union select label from t",
	"select grp, row_number() over (partition by grp order by label) as r from t",
	"with x as materialized (select * from t where id > 3) select count(*) as n from x",
];

const checks: Record<string, Check> = {
	async shape(ctx) {
		const db = createDoDriver(ctx.storage);
		assert.equal(db.adapter, "durable-objects");
		assert.equal(db.dialect, "sqlite");
		assert.deepEqual(db.capabilities, {
			sync: true,
			concurrentWriters: false,
			crossProcessLock: false,
		});
		assert.equal(db.sync?.adapter, "durable-objects");
		for (const wrong of [undefined, null, {}, ctx, { sql: {} }, "storage"]) {
			assert.throws(
				() => createDoDriver(wrong as never),
				(error) =>
					error instanceof TypeError && /ctx\.storage/.test(error.message),
			);
		}
	},

	async readsAreNotRefused(ctx) {
		const db = await seeded(ctx, 20);
		const tier = tierOf(db);
		await db.transaction(
			async (tx) => {
				for (const text of READS) {
					assert.ok((await tx.query(text)).rows.length > 0, text);
				}
			},
			{ readOnly: true },
		);
		tier.transaction(
			(tx) => {
				for (const text of READS) assert.ok(tx.query(text).rows.length > 0, text);
			},
			{ readOnly: true },
		);
	},

	async swallowedWriteRollsBack(ctx) {
		const db = await seeded(ctx);
		let caught: unknown;
		await assert.rejects(
			db.transaction(
				async (tx) => {
					await tx
						.query("insert into t (grp) values ('swallowed')")
						.catch((error) => {
							caught = error;
						});
					return "resolved anyway";
				},
				{ readOnly: true },
			),
			readOnly,
		);
		assert.ok(readOnly(caught), `the statement rejected with ${String(caught)}`);
		assert.equal(await count(db), 0, "the swallowed write was kept");

		const tier = tierOf(db);
		assert.throws(
			() =>
				tier.transaction(
					(tx) => {
						try {
							tx.exec("insert into t (grp) values ('swallowed')");
						} catch {
							// swallowed on purpose
						}
						return "returned anyway";
					},
					{ readOnly: true },
				),
			readOnly,
		);
		assert.equal(await count(db), 0, "the swallowed sync write was kept");
		// The connection writes again after it.
		await db.query("insert into t (grp) values ('after')");
		assert.equal(await count(db), 1);
	},

	async writeBeforeTheLastStatement(ctx) {
		// `rowsWritten` is the last statement's; `total_changes()` sees the rest.
		const db = await seeded(ctx);
		await assert.rejects(
			db.transaction(
				(tx) => tx.exec("insert into t (grp) values ('a'); select 1"),
				{
					readOnly: true,
				},
			),
			readOnly,
		);
		await assert.rejects(
			db.transaction(
				(tx) =>
					tx.query(
						"update t set grp = 'b'; insert into t (grp) values ('c'); select 1",
					),
				{ readOnly: true },
			),
			readOnly,
		);
		assert.throws(
			() =>
				tierOf(db).transaction(
					(tx) =>
						tx.exec(
							"delete from t; insert into t (grp) values ('d'); select 1",
						),
					{ readOnly: true },
				),
			readOnly,
		);
		assert.equal(await count(db), 0);
	},

	async bigints(ctx) {
		const db = createDoDriver(ctx.storage);
		const safe = BigInt(Number.MAX_SAFE_INTEGER);
		// Bound as a number, which workerd binds as a `real` as it does every number (F09);
		// an `integer` column stores it as an integer all the same.
		const { rows } = await db.query<{ n: unknown; m: unknown; t: unknown }>(
			sql`select ${42n} as n, ${-safe} as m, typeof(${safe}) as t`,
		);
		assert.deepEqual(rows, [{ n: 42, m: -Number.MAX_SAFE_INTEGER, t: "real" }]);
		await db.exec("create table big (v integer)");
		await db.query(sql`insert into big (v) values (${safe})`);
		const stored = await db.query("select v, typeof(v) as t from big");
		assert.deepEqual(stored.rows, [{ v: Number.MAX_SAFE_INTEGER, t: "integer" }]);
		const beyond = /safe-integer range/;
		await assert.rejects(
			db.query(sql`select ${safe + 1n} as n`),
			(error) => error instanceof TypeError && beyond.test(error.message),
		);
		await assert.rejects(
			db.query("select ? as n", [-(2n ** 63n)]),
			(error) => error instanceof TypeError && beyond.test(error.message),
		);
		assert.throws(
			() => tierOf(db).query(sql`select ${2n ** 53n} as n`),
			(error) => error instanceof TypeError && beyond.test(error.message),
		);
	},

	async closeLeavesTheStorage(ctx) {
		const first = await seeded(ctx);
		await first.query("insert into t (grp) values ('kept')");
		await first.close();
		await first.close();
		await assert.rejects(first.query("select 1"), SqlError);
		await assert.rejects(first.exec("select 1"), SqlError);
		await assert.rejects(
			first.transaction(async () => undefined),
			SqlError,
		);
		assert.throws(() => tierOf(first).query("select 1"), SqlError);
		// The storage is the object's, and as it was.
		const second = createDoDriver(ctx.storage);
		const { rows } = await second.query("select grp from t");
		assert.deepEqual(rows, [{ grp: "kept" }]);
	},
};

export class TestObject extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
		const check = checks[name];
		if (!check) {
			return Response.json({
				ok: false,
				error: { name: "TypeError", message: `no check named "${name}"` },
			});
		}
		try {
			await check(this.ctx);
			return Response.json({ ok: true, value: null });
		} catch (error) {
			const { name, message, stack } =
				error instanceof Error ? error : new Error(String(error));
			return Response.json({ ok: false, error: { name, message, stack } });
		}
	}
}
