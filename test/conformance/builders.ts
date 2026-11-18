// The `builders` conformance body: the statement builders' fragments executed on every
// registered adapter (plan doc 03 #1). The unit test pins the text each one renders; this
// body holds both dialects to running it: an insert of two rows, an update with
// `returning`, an upsert that inserts and then updates, a `do nothing` upsert, a delete,
// and the `where` pieces in a query.
//
// Runner-agnostic: no `node:test` here, so the same cases run inside workerd. Every case
// creates and disposes a database of its own, holding one table whose DDL both dialects
// read alike and whose `integer` column comes back a number on both.

import assert from "node:assert/strict";
import {
	and,
	type Driver,
	deleteFrom,
	inList,
	insert,
	or,
	raw,
	type Sql,
	type SyncDriver,
	sql,
	update,
	upsert,
	whereEq,
} from "../../src/mod.ts";
import type { AdapterCase, Suite } from "./_suite.ts";

interface Item {
	id: string;
	name: string;
	n: number | null;
}

/** Every row of `item`, by id. */
async function items(db: Driver): Promise<Item[]> {
	const { rows } = await db.query<Item>(sql`select id, name, n from item order by id`);
	return rows;
}

export function buildersContract(suite: Suite, adapter: AdapterCase): void {
	/** One case, on a database of its own holding an empty table `item`. */
	const test = (name: string, body: (db: Driver) => Promise<void>): void => {
		suite.test(name, async () => {
			const fixture = await adapter.create();
			try {
				await fixture.driver.exec(
					"create table item (id text primary key, name text not null, n integer)",
				);
				await body(fixture.driver);
			} finally {
				await fixture.dispose();
			}
		});
	};

	test("builders: insert writes two rows in one statement", async (db) => {
		const result = await db.query(
			insert("item", [
				{ id: "a", name: "A", n: 1 },
				{ n: 2, name: "B", id: "b" },
			]),
		);
		assert.deepEqual(result, { rows: [], rowCount: 2 });
		assert.deepEqual(await items(db), [
			{ id: "a", name: "A", n: 1 },
			{ id: "b", name: "B", n: 2 },
		]);
	});

	test("builders: insert with returning hands the rows back, undefined left out", async (db) => {
		const result = await db.query<Item>(
			insert("item", { id: "a", name: "A", n: undefined }, { returning: "*" }),
		);
		assert.deepEqual(result, {
			rows: [{ id: "a", name: "A", n: null }],
			rowCount: 1,
		});
	});

	test("builders: update with returning changes the matched row only", async (db) => {
		await db.query(
			insert("item", [
				{ id: "a", name: "A", n: 1 },
				{ id: "b", name: "B", n: 2 },
			]),
		);
		const result = await db.query<Item>(
			update(
				"item",
				{ name: "A2", n: sql`n + ${10}` },
				{ id: "a" },
				{ returning: ["id", "name", "n"] },
			),
		);
		assert.deepEqual(result, { rows: [{ id: "a", name: "A2", n: 11 }], rowCount: 1 });
		assert.deepEqual(await items(db), [
			{ id: "a", name: "A2", n: 11 },
			{ id: "b", name: "B", n: 2 },
		]);
	});

	test('builders: update where raw("true") touches every row', async (db) => {
		await db.query(
			insert("item", [
				{ id: "a", name: "A", n: 1 },
				{ id: "b", name: "B", n: 2 },
			]),
		);
		const result = await db.query(update("item", { n: null }, raw("true")));
		assert.equal(result.rowCount, 2);
		assert.deepEqual(
			(await items(db)).map((row) => row.n),
			[null, null],
		);
	});

	test("builders: an upsert inserts, then updates the row it clashes with", async (db) => {
		const first = await db.query<Item>(
			upsert(
				"item",
				{ id: "a", name: "A", n: 1 },
				{ conflict: ["id"], returning: "*" },
			),
		);
		assert.deepEqual(first, { rows: [{ id: "a", name: "A", n: 1 }], rowCount: 1 });
		const second = await db.query<Item>(
			upsert(
				"item",
				{ id: "a", name: "A2", n: 2 },
				{ conflict: ["id"], returning: "*" },
			),
		);
		assert.deepEqual(second, { rows: [{ id: "a", name: "A2", n: 2 }], rowCount: 1 });
		assert.deepEqual(await items(db), [{ id: "a", name: "A2", n: 2 }]);
	});

	test("builders: an upsert's update list overwrites only those columns", async (db) => {
		await db.query(insert("item", { id: "a", name: "A", n: 1 }));
		await db.query(
			upsert(
				"item",
				{ id: "a", name: "A2", n: 2 },
				{ conflict: ["id"], update: ["n"] },
			),
		);
		assert.deepEqual(await items(db), [{ id: "a", name: "A", n: 2 }]);
	});

	test("builders: a do-nothing upsert keeps the existing row", async (db) => {
		await db.query(insert("item", { id: "a", name: "A", n: 1 }));
		const kept = await db.query<Item>(
			upsert(
				"item",
				{ id: "a", name: "X", n: 9 },
				{ conflict: ["id"], update: [], returning: "*" },
			),
		);
		assert.deepEqual(kept, { rows: [], rowCount: 0 });
		// Without returning too: the clash writes nothing, and a fresh key is inserted.
		const plain = await db.query(
			upsert("item", { id: "a", name: "Y" }, { conflict: ["id"], update: [] }),
		);
		assert.equal(plain.rowCount, 0);
		const fresh = await db.query(
			upsert("item", { id: "b", name: "B" }, { conflict: ["id"], update: [] }),
		);
		assert.equal(fresh.rowCount, 1);
		assert.deepEqual(await items(db), [
			{ id: "a", name: "A", n: 1 },
			{ id: "b", name: "B", n: null },
		]);
	});

	test("builders: deleteFrom removes the matched rows and returns them", async (db) => {
		await db.query(
			insert("item", [
				{ id: "a", name: "A", n: 1 },
				{ id: "b", name: "B", n: 2 },
				{ id: "c", name: "C", n: 3 },
			]),
		);
		const one = await db.query(
			deleteFrom("item", { id: "a" }, { returning: ["id"] }),
		);
		assert.deepEqual(one, { rows: [{ id: "a" }], rowCount: 1 });
		const rest = await db.query(deleteFrom("item", sql`id in ${inList(["b", "x"])}`));
		assert.equal(rest.rowCount, 1);
		assert.deepEqual(await items(db), [{ id: "c", name: "C", n: 3 }]);
	});

	test("builders: whereEq, and, or and inList select the rows they say", async (db) => {
		await db.query(
			insert("item", [
				{ id: "a", name: "same", n: null },
				{ id: "b", name: "same", n: 2 },
				{ id: "c", name: "other", n: null },
				{ id: "d", name: "other", n: 4 },
			]),
		);
		const ids = async (where: Sql): Promise<string[]> => {
			const { rows } = await db.query<{ id: string }>(
				sql`select id from item where ${where} order by id`,
			);
			return rows.map((row) => row.id);
		};
		assert.deepEqual(await ids(whereEq({ name: "same", n: null })), ["a"]);
		assert.deepEqual(await ids(whereEq({ n: null })), ["a", "c"]);
		assert.deepEqual(
			await ids(or(whereEq({ id: "a" }), sql`id in ${inList(["c", "d"])}`)),
			["a", "c", "d"],
		);
		assert.deepEqual(
			await ids(
				and(whereEq({ name: "other" }), or(sql`n > ${3}`, whereEq({ n: null }))),
			),
			["c", "d"],
		);
	});

	if (adapter.sync) {
		suite.test("builders: the sync tier executes the same fragments", async () => {
			const fixture = await adapter.create();
			try {
				const db = fixture.driver.sync as SyncDriver;
				db.exec(
					"create table item (id text primary key, name text not null, n integer)",
				);
				assert.equal(
					db.query(
						insert("item", [
							{ id: "a", name: "A" },
							{ id: "b", name: "B" },
						]),
					).rowCount,
					2,
				);
				assert.deepEqual(
					db.query(
						update("item", { n: 1 }, { id: "a" }, { returning: ["id", "n"] }),
					).rows,
					[{ id: "a", n: 1 }],
				);
				assert.equal(db.query(deleteFrom("item", { id: "b" })).rowCount, 1);
				assert.deepEqual(await items(fixture.driver), [
					{ id: "a", name: "A", n: 1 },
				]);
			} finally {
				await fixture.dispose();
			}
		});
	}
}
