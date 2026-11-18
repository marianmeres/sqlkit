// The `decoders` conformance body: what a driver really hands back, decoded (plan doc 03 #5).
// The unit test pins each decoder on fabricated values; this body holds every adapter to
// the round trip: a boolean, a `Date`, a JSON object, a `bigint` and a fraction, written
// through the parameter rule, read back raw, and decoded to values equal to the originals.
//
// Runner-agnostic: no `node:test` here, so the same cases run inside workerd. Every case
// creates and disposes a database of its own. The table's DDL is per dialect, read from
// `driver.dialect`: Postgres has the types (`boolean`, `timestamptz`, `jsonb`, `bigint`,
// `numeric`), SQLite stores the same values as `integer`, `text`, `text`, `integer`, `real`.

import assert from "node:assert/strict";
import {
	type DialectName,
	type Driver,
	decode,
	decodeRows,
	insert,
	json,
	type Row,
	raw,
	type SyncDriver,
	sql,
} from "../../src/mod.ts";
import type { AdapterCase, Suite } from "./_suite.ts";

const DDL: Record<DialectName, string> = {
	pg: "create table thing (id integer primary key, flag boolean, at timestamptz, doc jsonb, big bigint, price numeric(10, 2))",
	sqlite: "create table thing (id integer primary key, flag integer, at text, doc text, big integer, price real)",
};

const SPEC = {
	flag: decode.bool,
	at: decode.instant,
	doc: decode.json,
	big: decode.bigint,
	price: decode.number,
};

/** The rows written, as they are written: each value bound by the parameter rule. */
const FIRST = {
	id: 1,
	flag: true,
	at: new Date("2026-01-02T03:04:05.678Z"),
	doc: { name: "a", list: [1, "x", null], nested: { ok: true } },
	big: 1234567890123n,
	price: 12.5,
};
const SECOND = {
	id: 2,
	flag: false,
	at: new Date(0),
	doc: json([1, "two", { three: 3 }]),
	big: -9007199254740991n,
	price: 0,
};
const THIRD = { id: 3, flag: null, at: null, doc: null, big: null, price: null };
const WRITTEN = [FIRST, SECOND, THIRD];

/** The rows read back and decoded: equal to the originals. */
const EXPECTED = [FIRST, { ...SECOND, doc: [1, "two", { three: 3 }] }, THIRD];

const SELECT = sql`select id, flag, at, doc, big, price from thing order by id`;

/** What SQLite hands back for the rows, undecoded: it has none of the types. */
function assertSqliteRaw(rows: readonly Row[]): void {
	assert.deepEqual(
		rows.map((row) => [row.flag, row.at, typeof row.doc]),
		[
			[1, "2026-01-02T03:04:05.678Z", "string"],
			[0, "1970-01-01T00:00:00.000Z", "string"],
			[null, null, "object"],
		],
	);
}

export function decodersContract(suite: Suite, adapter: AdapterCase): void {
	/** One case, on a database of its own holding the dialect's table `thing`. */
	const test = (name: string, body: (db: Driver) => Promise<void>): void => {
		suite.test(name, async () => {
			const fixture = await adapter.create();
			try {
				await fixture.driver.exec(DDL[fixture.driver.dialect]);
				await body(fixture.driver);
			} finally {
				await fixture.dispose();
			}
		});
	};

	test("decoders: written through the parameter rule, read raw, decoded equal", async (db) => {
		await db.query(insert("thing", WRITTEN));
		const { rows } = await db.query(SELECT);
		if (db.dialect === "sqlite") assertSqliteRaw(rows);
		assert.deepEqual(decodeRows(rows, SPEC), EXPECTED);
	});

	test("decoders: a time the database wrote itself decodes to when it was written", async (db) => {
		// SQLite writes `current_timestamp` as UTC with no offset, to the second; Postgres
		// hands back a `Date`. The margin is for SQLite's second; a misread zone is hours.
		const before = Date.now();
		await db.query(insert("thing", { id: 9, at: raw("current_timestamp") }));
		const after = Date.now();
		const { rows } = await db.query(sql`select at from thing where id = 9`);
		const decoded = decodeRows(rows, { at: decode.instant })[0]?.at;
		assert.ok(decoded instanceof Date, `decoded ${String(decoded)}`);
		const at = decoded.getTime();
		assert.ok(
			at >= before - 2_000 && at <= after + 2_000,
			`decoded ${new Date(at).toISOString()} from ${String(rows[0]?.at)}, written between ${new Date(before).toISOString()} and ${new Date(after).toISOString()}`,
		);
	});

	test("decoders: a decoded row keeps the columns the spec does not name", async (db) => {
		await db.query(insert("thing", FIRST));
		const { rows } = await db.query(sql`select id, flag from thing`);
		assert.deepEqual(decodeRows(rows, { flag: decode.bool }), [
			{ id: 1, flag: true },
		]);
	});

	if (adapter.sync) {
		suite.test("decoders: rows from the sync tier decode the same", async () => {
			const fixture = await adapter.create();
			try {
				const db = fixture.driver.sync as SyncDriver;
				db.exec(DDL[fixture.driver.dialect]);
				db.query(insert("thing", WRITTEN));
				const { rows } = db.query(SELECT);
				if (fixture.driver.dialect === "sqlite") assertSqliteRaw(rows);
				assert.deepEqual(decodeRows(rows, SPEC), EXPECTED);
			} finally {
				await fixture.dispose();
			}
		});
	}
}
