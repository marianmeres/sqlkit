// The one parameter rule (plan doc 01 #2, D14): a case per cell of its table, on both
// dialects, plus what the rule refuses beyond the table's last row (an invalid Date, an
// object that is not plain, a fragment). Pure values, no database.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type DialectName,
	json,
	normalizeParam,
	normalizeParams,
	sql,
} from "../../src/mod.ts";

const DIALECTS: readonly DialectName[] = ["pg", "sqlite"];

/** A `TypeError` whose message matches `pattern`. */
function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

describe("unit/params: the table, row by row", () => {
	test("undefined and null bind NULL on both", () => {
		for (const dialect of DIALECTS) {
			assert.equal(normalizeParam(undefined, dialect), null, dialect);
			assert.equal(normalizeParam(null, dialect), null, dialect);
		}
	});

	test("a boolean is as is on pg", () => {
		assert.equal(normalizeParam(true, "pg"), true);
		assert.equal(normalizeParam(false, "pg"), false);
	});

	test("a boolean is 1 / 0 on sqlite", () => {
		assert.equal(normalizeParam(true, "sqlite"), 1);
		assert.equal(normalizeParam(false, "sqlite"), 0);
	});

	test("a Date is as is on pg: the same object", () => {
		const date = new Date("2026-11-18T12:34:56.789Z");
		assert.equal(normalizeParam(date, "pg"), date);
	});

	test("a Date is its ISO text on sqlite", () => {
		const date = new Date("2026-11-18T12:34:56.789Z");
		assert.equal(normalizeParam(date, "sqlite"), "2026-11-18T12:34:56.789Z");
	});

	test("a bigint is as is on both", () => {
		for (const dialect of DIALECTS) {
			assert.equal(normalizeParam(2n ** 62n, dialect), 2n ** 62n, dialect);
		}
	});

	test("a number is as is on both", () => {
		for (const dialect of DIALECTS) {
			for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
				assert.equal(normalizeParam(n, dialect), n, `${dialect} ${n}`);
			}
		}
	});

	test("a string is as is on both, JSON-looking or not", () => {
		for (const dialect of DIALECTS) {
			for (const s of ["", "x", '{"a":1}', "it's"]) {
				assert.equal(normalizeParam(s, dialect), s, `${dialect} ${s}`);
			}
		}
	});

	test("a Uint8Array is as is on both: the same object; a Buffer is one", () => {
		for (const dialect of DIALECTS) {
			const bytes = new Uint8Array([1, 2, 3]);
			assert.equal(normalizeParam(bytes, dialect), bytes, dialect);
			const buffer = Buffer.from("abc");
			assert.equal(normalizeParam(buffer, dialect), buffer, dialect);
		}
	});

	test("a plain object is its JSON text on both", () => {
		for (const dialect of DIALECTS) {
			assert.equal(
				normalizeParam({ a: 1, b: [true, null], c: { d: "x" } }, dialect),
				'{"a":1,"b":[true,null],"c":{"d":"x"}}',
				dialect,
			);
			assert.equal(normalizeParam({}, dialect), "{}", dialect);
			// No prototype at all is plain too: what a parsed query string often is.
			const bare = Object.assign(Object.create(null) as object, { a: 1 });
			assert.equal(normalizeParam(bare, dialect), '{"a":1}', dialect);
		}
	});

	test("an array is as is on pg: the same object, a Postgres array", () => {
		const array = [1, 2, 3];
		assert.equal(normalizeParam(array, "pg"), array);
		const nested = [
			["a", "b"],
			["c", "d"],
		];
		assert.equal(normalizeParam(nested, "pg"), nested);
	});

	test("an array is a TypeError on sqlite, naming json() and inList()", () => {
		for (const array of [[], [1, 2], [{ a: 1 }]]) {
			assert.throws(
				() => normalizeParam(array, "sqlite"),
				typeError(/json\(.*inList\(/),
			);
		}
	});

	test("a function and a symbol are a TypeError on both", () => {
		for (const dialect of DIALECTS) {
			for (const value of [() => 1, function named() {}, Symbol("s")]) {
				assert.throws(
					() => normalizeParam(value, dialect),
					typeError(/cannot bind a (function|symbol)/),
					`${dialect} ${String(value)}`,
				);
			}
		}
	});
});

describe("unit/params: beyond the table", () => {
	test("json(value) is how an array reaches sqlite: its value is already text", () => {
		const fragment = json([1, 2]);
		assert.equal(normalizeParam(fragment.values[0], "sqlite"), "[1,2]");
		assert.equal(normalizeParam(fragment.values[0], "pg"), "[1,2]");
	});

	test("an invalid Date is a TypeError on both", () => {
		for (const dialect of DIALECTS) {
			assert.throws(
				() => normalizeParam(new Date("not a date"), dialect),
				typeError(/invalid Date/),
				dialect,
			);
		}
	});

	test("an object that is not plain is a TypeError on both, naming its class", () => {
		class Money {
			amount = 1;
		}
		const cases: [unknown, RegExp][] = [
			[new Map([["a", 1]]), /a Map/],
			[new Set([1]), /a Set/],
			[new Money(), /a Money/],
			[new Float64Array([1]), /a Float64Array/],
			[new ArrayBuffer(1), /an? ArrayBuffer/],
			[/x/, /a RegExp/],
			[new String("boxed"), /a String/],
		];
		for (const dialect of DIALECTS) {
			for (const [value, pattern] of cases) {
				assert.throws(
					() => normalizeParam(value, dialect),
					typeError(pattern),
					`${dialect} ${pattern}`,
				);
			}
		}
	});

	test("a fragment is a TypeError on both: it belongs in a template", () => {
		for (const dialect of DIALECTS) {
			assert.throws(
				() => normalizeParam(sql`now()`, dialect),
				typeError(/fragment/),
				dialect,
			);
		}
	});

	test("a plain object JSON cannot write is a TypeError on both", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const dialect of DIALECTS) {
			assert.throws(() => normalizeParam({ n: 1n }, dialect), TypeError, dialect);
			assert.throws(() => normalizeParam(cycle, dialect), TypeError, dialect);
			assert.throws(
				() => normalizeParam({ toJSON: () => undefined }, dialect),
				typeError(/no JSON representation/),
				dialect,
			);
		}
	});

	test("an unknown dialect is a TypeError", () => {
		assert.throws(
			() => normalizeParam(1, "mysql" as DialectName),
			typeError(/unknown dialect "mysql"/),
		);
	});
});

describe("unit/params: normalizeParams", () => {
	test("applies the rule to every value, in order, into a new array", () => {
		const input: unknown[] = [
			undefined,
			null,
			true,
			"s",
			7,
			new Date("2026-11-18T00:00:00.000Z"),
			{ a: 1 },
		];
		const copy = [...input];
		const out = normalizeParams(input, "sqlite");
		assert.deepEqual(out, [
			null,
			null,
			1,
			"s",
			7,
			"2026-11-18T00:00:00.000Z",
			'{"a":1}',
		]);
		assert.notEqual(out, input);
		assert.deepEqual(input, copy);
	});

	test("an empty list is an empty list; a long one does not overflow", () => {
		assert.deepEqual(normalizeParams([], "pg"), []);
		const long = Array.from({ length: 200_000 }, (_, i) => i);
		assert.equal(normalizeParams(long, "pg").length, 200_000);
	});

	test("the first value that cannot bind fails the whole list", () => {
		assert.throws(() => normalizeParams([1, [2], 3], "sqlite"), TypeError);
	});

	test("anything but an array is a TypeError", () => {
		for (const value of [undefined, null, "abc", { length: 1, 0: "a" }]) {
			assert.throws(
				() => normalizeParams(value as unknown as unknown[], "pg"),
				typeError(/must be an array/),
				String(value),
			);
		}
	});
});
