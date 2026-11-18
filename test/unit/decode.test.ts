// The explicit row decoders: a case per cell of plan doc 03 #5's table (what each decoder
// accepts, what it refuses), then `decodeRow` and `decodeRows`. Pure values, no database:
// decoding what a driver really hands back is the `decoders` conformance body's. Imports
// the root entry point, so it also proves the decoders are exported there.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Decoder, decode, decodeRow, decodeRows, type Row } from "../../src/mod.ts";

/** A `TypeError` whose message matches `pattern`. */
function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

/** A value past the types, as untyped code would pass it. */
// biome-ignore lint/suspicious/noExplicitAny: the cases call the decoders as untyped code
const loose = (value: unknown): any => value;

/** Assert `decoder` refuses every one of `values`, naming the column and `found`. */
function refuses(
	decoder: Decoder<unknown>,
	name: string,
	values: readonly [unknown, RegExp][],
): void {
	for (const [value, found] of values) {
		assert.throws(
			() => decoder(value, "col"),
			(error: unknown) => {
				assert.ok(
					error instanceof TypeError,
					`${String(value)}: not a TypeError`,
				);
				assert.match(
					error.message,
					new RegExp(`^decode\\.${name}: column "col" holds `),
				);
				assert.match(error.message, found);
				return true;
			},
			`${typeof value} ${String(value)} was not refused`,
		);
	}
}

describe("unit/decode: the decoders", () => {
	test("every decoder reads null and undefined as null", () => {
		for (const [name, decoder] of Object.entries(decode)) {
			assert.equal(decoder(null, "col"), null, `${name}(null)`);
			assert.equal(decoder(undefined, "col"), null, `${name}(undefined)`);
		}
		assert.deepEqual(Object.keys(decode).sort(), [
			"bigint",
			"bool",
			"instant",
			"json",
			"number",
		]);
		assert.equal(Object.isFrozen(decode), true);
	});

	test("bool accepts true/false, 1/0, 1n/0n, t/f, true/false, 1/0 as text", () => {
		const cases: [unknown, boolean][] = [
			[true, true],
			[false, false],
			[1, true],
			[0, false],
			[1n, true],
			[0n, false],
			["t", true],
			["f", false],
			["true", true],
			["false", false],
			["1", true],
			["0", false],
		];
		for (const [value, expected] of cases) {
			assert.equal(
				decode.bool(value, "col"),
				expected,
				`${typeof value} ${String(value)}`,
			);
		}
	});

	test("bool refuses anything else", () => {
		refuses(decode.bool, "bool", [
			[2, /^.* a number other than 1 or 0$/],
			[-1, /a number other than 1 or 0$/],
			[0.5, /a number other than 1 or 0$/],
			[Number.NaN, /a number other than 1 or 0$/],
			[2n, /a bigint other than 1n or 0n$/],
			["yes", /a string that is not a boolean$/],
			["T", /a string that is not a boolean$/],
			["TRUE", /a string that is not a boolean$/],
			[" 1", /a string that is not a boolean$/],
			["", /a string that is not a boolean$/],
			[{}, /an object, not a boolean$/],
			[[true], /an array, not a boolean$/],
			[new Date(0), /a Date, not a boolean$/],
		]);
	});

	test("instant accepts a Date, a string Date parses, a number of epoch milliseconds", () => {
		const at = new Date("2026-01-02T03:04:05.678Z");
		assert.equal(decode.instant(at, "col"), at, "a Date is returned as it is");
		assert.deepEqual(decode.instant("2026-01-02T03:04:05.678Z", "col"), at);
		assert.deepEqual(decode.instant("2026-01-02T04:04:05.678+01:00", "col"), at);
		assert.deepEqual(decode.instant(at.getTime(), "col"), at);
		assert.deepEqual(decode.instant(0, "col"), new Date(0));
		assert.deepEqual(
			decode.instant("2026-01-02", "col"),
			new Date(Date.UTC(2026, 0, 2)),
		);
	});

	test("instant reads a date and time with no offset as UTC, as SQLite writes it", (t) => {
		// `Date` alone would read these as local time, wrong by the host's offset, and on a
		// host whose zone is UTC (CI) nothing would show it: so not one here. Node applies a
		// change of TZ at once, and this file runs in a process of its own.
		const zone = process.env.TZ;
		process.env.TZ = "Asia/Kathmandu"; // +05:45, no daylight saving
		t.after(() => {
			if (zone === undefined) delete process.env.TZ;
			else process.env.TZ = zone;
		});
		assert.equal(new Date(2026, 0, 2).getTimezoneOffset(), -345);
		const utc = (ms: number) => new Date(Date.UTC(2026, 0, 2, 3, 4, 5, ms));
		assert.deepEqual(decode.instant("2026-01-02 03:04:05", "col"), utc(0));
		assert.deepEqual(decode.instant("2026-01-02T03:04:05", "col"), utc(0));
		assert.deepEqual(decode.instant("2026-01-02 03:04:05.678", "col"), utc(678));
		assert.deepEqual(decode.instant("2026-01-02T03:04:05.678123", "col"), utc(678));
		assert.deepEqual(
			decode.instant("2026-01-02 03:04", "col"),
			new Date(Date.UTC(2026, 0, 2, 3, 4)),
		);
		// An offset is honoured as it is written.
		assert.deepEqual(decode.instant("2026-01-02 04:04:05+01:00", "col"), utc(0));
		refuses(decode.instant, "instant", [
			["2026-13-02 03:04:05", /a string that is not a valid date$/],
		]);
	});

	test("instant refuses an invalid date, and anything that is not a date", () => {
		refuses(decode.instant, "instant", [
			[new Date(Number.NaN), /a Date that is not a valid date$/],
			["", /a string that is not a valid date$/],
			["yesterday", /a string that is not a valid date$/],
			[Number.NaN, /a number that is not a valid date$/],
			[Number.POSITIVE_INFINITY, /a number that is not a valid date$/],
			[8.64e15 + 1, /a number that is not a valid date$/],
			[1n, /a bigint, not a date$/],
			[true, /a boolean, not a date$/],
			[{}, /an object, not a date$/],
		]);
	});

	test("json parses a string and passes any other value through as it is", () => {
		assert.deepEqual(decode.json('{"a":[1,"x",null],"b":{"c":true}}', "col"), {
			a: [1, "x", null],
			b: { c: true },
		});
		assert.deepEqual(decode.json("[1,2]", "col"), [1, 2]);
		assert.equal(decode.json('"text"', "col"), "text");
		assert.equal(decode.json("12", "col"), 12);
		assert.equal(decode.json("null", "col"), null);
		const object = { a: 1 };
		assert.equal(
			decode.json(object, "col"),
			object,
			"an object is returned as it is",
		);
		const array = [1, 2];
		assert.equal(decode.json(array, "col"), array);
		assert.equal(decode.json(12, "col"), 12);
		assert.equal(decode.json(true, "col"), true);
	});

	test("json refuses a string that is not JSON, without quoting it", () => {
		refuses(decode.json, "json", [
			["", /a string that is not JSON$/],
			["{a:1}", /a string that is not JSON$/],
			["secret-token", /a string that is not JSON$/],
		]);
		assert.throws(
			() => decode.json("secret-token", "col"),
			(error: unknown) =>
				error instanceof TypeError &&
				!error.message.includes("secret") &&
				error.cause === undefined,
		);
	});

	test("bigint accepts a bigint, an integer number, a string of digits with a sign", () => {
		const cases: [unknown, bigint][] = [
			[12n, 12n],
			[-12n, -12n],
			[12, 12n],
			[-12, -12n],
			[0, 0n],
			[-0, 0n],
			[2 ** 60, 2n ** 60n],
			["12", 12n],
			["+12", 12n],
			["-12", -12n],
			["007", 7n],
			["9007199254740993", 9007199254740993n],
			["-123456789012345678901234567890", -123456789012345678901234567890n],
		];
		for (const [value, expected] of cases) {
			assert.equal(
				decode.bigint(value, "col"),
				expected,
				`${typeof value} ${String(value)}`,
			);
		}
	});

	test("bigint refuses anything else", () => {
		refuses(decode.bigint, "bigint", [
			[1.5, /a number that is not an integer$/],
			[Number.NaN, /a number that is not an integer$/],
			[Number.POSITIVE_INFINITY, /a number that is not an integer$/],
			["1.5", /a string that is not an integer$/],
			["1e3", /a string that is not an integer$/],
			["0x10", /a string that is not an integer$/],
			[" 12", /a string that is not an integer$/],
			["12 ", /a string that is not an integer$/],
			["", /a string that is not an integer$/],
			["-", /a string that is not an integer$/],
			[true, /a boolean, not an integer$/],
			[new Date(0), /a Date, not an integer$/],
			[[1], /an array, not an integer$/],
		]);
	});

	test("number accepts a finite number, bigint or decimal string, safe if an integer", () => {
		const cases: [unknown, number][] = [
			[12, 12],
			[-1.5, -1.5],
			[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
			[-Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER],
			[12n, 12],
			[BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
			[-BigInt(Number.MAX_SAFE_INTEGER), -Number.MAX_SAFE_INTEGER],
			["12", 12],
			["-12.5", -12.5],
			["+0.25", 0.25],
			[".5", 0.5],
			["5.", 5],
			["123.4500", 123.45],
			["1e3", 1000],
			["1.5E-3", 0.0015],
			["9007199254740991", Number.MAX_SAFE_INTEGER],
		];
		for (const [value, expected] of cases) {
			assert.equal(
				decode.number(value, "col"),
				expected,
				`${typeof value} ${String(value)}`,
			);
		}
	});

	test("number refuses anything else", () => {
		refuses(decode.number, "number", [
			[Number.NaN, /a number that is not a finite number$/],
			[Number.POSITIVE_INFINITY, /a number that is not a finite number$/],
			[Number.MAX_SAFE_INTEGER + 1, /a number outside the safe integer range/],
			[1e300, /a number outside the safe integer range/],
			[
				BigInt(Number.MAX_SAFE_INTEGER) + 1n,
				/a bigint outside the safe integer range/,
			],
			[-(10n ** 400n), /a bigint outside the safe integer range.*decode\.bigint$/],
			["9007199254740993", /a string outside the safe integer range/],
			["1e400", /a string that is not a finite number$/],
			["NaN", /a string that is not a number$/],
			["Infinity", /a string that is not a number$/],
			["0x10", /a string that is not a number$/],
			["", /a string that is not a number$/],
			[" 1", /a string that is not a number$/],
			["1,5", /a string that is not a number$/],
			[true, /a boolean, not a number$/],
			[{}, /an object, not a number$/],
		]);
	});

	test("a refusal names the column, or says 'the value' when called without one", () => {
		assert.throws(
			() => decode.bool("maybe", "is_active"),
			typeError(
				/^decode\.bool: column "is_active" holds a string that is not a boolean$/,
			),
		);
		assert.throws(
			() => loose(decode.bool)("maybe"),
			typeError(/^decode\.bool: the value holds a string that is not a boolean$/),
		);
		class Money {}
		assert.throws(
			() => decode.number(new Money(), "price"),
			typeError(/^decode\.number: column "price" holds a Money, not a number$/),
		);
		assert.throws(
			() => decode.number(Object.create(null), "price"),
			typeError(/holds an object, not a number$/),
		);
		assert.throws(
			() => decode.number(Symbol("s"), "price"),
			typeError(/holds a symbol, not a number$/),
		);
	});
});

describe("unit/decode: decodeRow and decodeRows", () => {
	const spec = {
		active: decode.bool,
		created_at: decode.instant,
		data: decode.json,
		big: decode.bigint,
		price: decode.number,
	};

	test("decodeRow decodes the named columns and leaves every other one alone", () => {
		const raw: Row = {
			id: "a",
			active: 1,
			created_at: "2026-01-02T03:04:05.678Z",
			data: '{"tags":["x"]}',
			big: "9007199254740993",
			price: "12.50",
			note: "1",
		};
		const row = decodeRow(raw, spec);
		assert.deepEqual(row, {
			id: "a",
			active: true,
			created_at: new Date("2026-01-02T03:04:05.678Z"),
			data: { tags: ["x"] },
			big: 9007199254740993n,
			price: 12.5,
			note: "1",
		});
		assert.notEqual(row, raw, "a new row");
		assert.equal(raw.active, 1, "the input row is left as it was");
		// The types: each decoded column has its decoder's return type.
		const active: boolean | null = row.active;
		const createdAt: Date | null = row.created_at;
		const big: bigint | null = row.big;
		const price: number | null = row.price;
		assert.deepEqual(
			[active, createdAt?.getTime(), big, price],
			[true, Date.UTC(2026, 0, 2, 3, 4, 5, 678), 9007199254740993n, 12.5],
		);
	});

	test("decodeRow: null stays null; a custom decoder gets the value and the column", () => {
		const seen: [unknown, string][] = [];
		const upper: Decoder<string> = (value, column) => {
			seen.push([value, column]);
			return String(value).toUpperCase();
		};
		const row = decodeRow({ a: null, b: "x" }, { a: decode.bool, b: upper });
		assert.deepEqual(row, { a: null, b: "X" });
		assert.deepEqual(seen, [["x", "b"]]);
		const b: string = row.b;
		assert.equal(b, "X");
	});

	test("decodeRow refuses a column the spec names that the row does not have", () => {
		assert.throws(
			() => decodeRow({ id: 1, actve: 1 }, { active: decode.bool }),
			typeError(
				/^decodeRow: the row has no column "active", which the spec names$/,
			),
		);
		// An inherited property is not a column.
		assert.throws(
			() => decodeRow(Object.create({ active: 1 }), { active: decode.bool }),
			typeError(/no column "active"/),
		);
	});

	test("decodeRow refuses a row or a spec of the wrong shape", () => {
		assert.throws(
			() => decodeRow(loose(null), spec),
			typeError(/^decodeRow: the row must be an object, got null$/),
		);
		assert.throws(
			() => decodeRow(loose([1]), spec),
			typeError(/^decodeRow: the row must be an object, got an array$/),
		);
		assert.throws(
			() => decodeRow({ a: 1 }, loose(null)),
			typeError(/^decode: the spec must be an object, got null$/),
		);
		assert.throws(
			() => decodeRow({ a: 1 }, loose({ a: "bool" })),
			typeError(
				/^decode: the spec's "a" must be a decoder function, got a string$/,
			),
		);
	});

	test("decodeRow: an empty spec copies the row", () => {
		const raw = { a: 1 };
		const row = decodeRow(raw, {});
		assert.deepEqual(row, raw);
		assert.notEqual(row, raw);
	});

	test("decodeRow: a refusal is the decoder's, naming the column", () => {
		assert.throws(
			() => decodeRow({ active: "maybe" }, { active: decode.bool }),
			typeError(
				/^decode\.bool: column "active" holds a string that is not a boolean$/,
			),
		);
	});

	test("decodeRows decodes every row into a new array", () => {
		const raw: Row[] = [
			{ id: 1, active: 1, data: "[1]" },
			{ id: 2, active: "f", data: null },
		];
		const rows = decodeRows(raw, { active: decode.bool, data: decode.json });
		assert.deepEqual(rows, [
			{ id: 1, active: true, data: [1] },
			{ id: 2, active: false, data: null },
		]);
		assert.notEqual(rows, raw);
		assert.deepEqual(decodeRows([], { active: decode.bool }), []);
		const first: boolean | null | undefined = rows[0]?.active;
		assert.equal(first, true);
	});

	test("decodeRows names the row a missing column is missing from", () => {
		assert.throws(
			() => decodeRows([{ active: 1 }, { id: 2 }], { active: decode.bool }),
			typeError(/^decodeRows: row 1 has no column "active", which the spec names$/),
		);
		assert.throws(
			() => decodeRows([{ active: 1 }, loose("x")], { active: decode.bool }),
			typeError(/^decodeRows: row 1 must be an object, got a string$/),
		);
	});

	test("decodeRows refuses rows that are not an array, and checks the spec once", () => {
		assert.throws(
			() => decodeRows(loose({ length: 0 }), spec),
			typeError(/^decodeRows: rows must be an array, got an object$/),
		);
		assert.throws(
			() => decodeRows([], loose({ a: 1 })),
			typeError(
				/^decode: the spec's "a" must be a decoder function, got a number$/,
			),
		);
	});
});
