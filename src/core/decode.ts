/**
 * Explicit row decoders: functions that turn a column's raw value into the JavaScript value
 * it stands for, named per column by the caller.
 *
 * The drivers hand back what their database stores. SQLite has no boolean, instant or JSON
 * type: it returns `1`, the ISO text the parameter rule wrote, and JSON text, and reports no
 * column type that would say which is which. Postgres returns a string for `int8` and
 * `numeric`, which a number cannot always hold. Decoding automatically would need a
 * declared schema, the first step toward an ORM, so decoding here is opt-in and per column:
 *
 *     const { rows } = await db.query(sql`select id, active, created_at, data from job`);
 *     const jobs = decodeRows(rows, {
 *     	active: decode.bool,
 *     	created_at: decode.instant,
 *     	data: decode.json,
 *     });
 *
 * | Decoder   | Accepts                                                                     |
 * | --------- | --------------------------------------------------------------------------- |
 * | `bool`    | `true`/`false`, `1`/`0`, `1n`/`0n`, `"t"`/`"f"`, `"true"`/`"false"`, `"1"`/`"0"` |
 * | `instant` | a valid `Date`, a string `Date` parses (no offset: UTC), epoch milliseconds |
 * | `json`    | a string, parsed as JSON; any other value as it is                          |
 * | `bigint`  | a `bigint`, an integer `number`, a string of digits with an optional sign   |
 * | `number`  | a `number`, `bigint` or decimal string that is finite and, if an integer, safe |
 *
 * Every decoder reads `null` and `undefined` as `null`, and refuses anything else with a
 * `TypeError` that names the column and the type it found. The value itself is not quoted:
 * it is data, and an error message is what reaches a log.
 *
 * `instant` reads a date and time with no offset as UTC (`2026-01-02 03:04:05`, with a
 * space or a `T`, seconds and a fraction optional), where `Date` would read local time:
 * that is how SQLite's `CURRENT_TIMESTAMP`, `datetime()` and `strftime()` write UTC. Any
 * other string is read as `Date` reads it. A `Date` written through the parameter rule is
 * ISO text with its `Z`, and reads back as it was. On `pg` node-postgres hands back a
 * `Date` already, which is returned as it is.
 *
 * One thing the decoders cannot tell, because they see a value and not its column type:
 * `json` parses every string. On `pg` a `json` or `jsonb` column arrives parsed already, so
 * a column whose JSON value is itself a string arrives as that string and is parsed a
 * second time. It suits a column of objects or arrays, which is what it is for.
 *
 * `decodeRow` and `decodeRows` apply a spec, an object of column names to decoders, and
 * return new rows: a column the spec names is decoded, any other is left as it was. A
 * column the spec names that the row does not have is a `TypeError`: a driver hands back
 * every column it selected, so a missing one is a spec that does not match its query.
 *
 * Runtime-neutral: imports only the contract's types.
 */

import type { Row } from "./contract.ts";

/** Turns one column's raw value into what it stands for, or throws a `TypeError`. */
export type Decoder<T> = (value: unknown, column: string) => T;

/** `true`/`false`, `1`/`0`, `1n`/`0n`, `"t"`/`"f"`, `"true"`/`"false"`, `"1"`/`"0"`. */
function bool(value: unknown, column: string): boolean | null {
	if (value === null || value === undefined) return null;
	switch (typeof value) {
		case "boolean":
			return value;
		case "number":
			if (value === 1) return true;
			if (value === 0) return false;
			throw refusal("bool", column, `${kindOf(value)} other than 1 or 0`);
		case "bigint":
			if (value === 1n) return true;
			if (value === 0n) return false;
			throw refusal("bool", column, `${kindOf(value)} other than 1n or 0n`);
		case "string":
			if (value === "t" || value === "true" || value === "1") return true;
			if (value === "f" || value === "false" || value === "0") return false;
			throw refusal("bool", column, `${kindOf(value)} that is not a boolean`);
	}
	throw refusal("bool", column, `${kindOf(value)}, not a boolean`);
}

/**
 * A date and time with no offset, as SQLite's date and time functions write it
 * (`2026-01-02 03:04:05`, `2026-01-02T03:04:05.678`): read as UTC, as SQLite means it.
 */
const SQL_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * A valid `Date` as it is; a string `Date` parses, but one with a date and time and no
 * offset read as UTC; a number of epoch milliseconds.
 */
function instant(value: unknown, column: string): Date | null {
	if (value === null || value === undefined) return null;
	let date: Date;
	if (value instanceof Date) date = value;
	else if (typeof value === "string") {
		const parts = SQL_DATETIME.exec(value);
		date = new Date(parts === null ? value : `${parts[1]}T${parts[2]}Z`);
	} else if (typeof value === "number") {
		date = new Date(value);
	} else {
		throw refusal("instant", column, `${kindOf(value)}, not a date`);
	}
	if (Number.isNaN(date.getTime())) {
		throw refusal("instant", column, `${kindOf(value)} that is not a valid date`);
	}
	return date;
}

/** A string parsed as JSON; any other value as it is. */
function json(value: unknown, column: string): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		// The parser's own message quotes the text, which is data: not carried on.
		throw refusal("json", column, `${kindOf(value)} that is not JSON`);
	}
}

/** A string of digits, with an optional sign and nothing else. */
const INTEGER_TEXT = /^[+-]?\d+$/;

/** A `bigint`; an integer `number`; a string of digits with an optional sign. */
function bigint(value: unknown, column: string): bigint | null {
	if (value === null || value === undefined) return null;
	switch (typeof value) {
		case "bigint":
			return value;
		case "number":
			if (Number.isInteger(value)) return BigInt(value);
			throw refusal("bigint", column, `${kindOf(value)} that is not an integer`);
		case "string":
			if (INTEGER_TEXT.test(value)) return BigInt(value);
			throw refusal("bigint", column, `${kindOf(value)} that is not an integer`);
	}
	throw refusal("bigint", column, `${kindOf(value)}, not an integer`);
}

/** A decimal number in text: digits with an optional fraction, sign and exponent. */
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The largest integer a number holds exactly, as a `bigint`. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A `number`, `bigint` or decimal string that is finite and, if an integer, safe. */
function number(value: unknown, column: string): number | null {
	if (value === null || value === undefined) return null;
	let n: number;
	switch (typeof value) {
		case "number":
			n = value;
			break;
		case "bigint":
			if (value > MAX_SAFE || value < -MAX_SAFE) throw unsafe(value, column);
			n = Number(value);
			break;
		case "string":
			if (!DECIMAL_TEXT.test(value)) {
				throw refusal("number", column, `${kindOf(value)} that is not a number`);
			}
			n = Number(value);
			break;
		default:
			throw refusal("number", column, `${kindOf(value)}, not a number`);
	}
	if (!Number.isFinite(n)) {
		throw refusal("number", column, `${kindOf(value)} that is not a finite number`);
	}
	// Every number from 2^53 up is an integer, so "unsafe" is the one test for magnitude.
	if (Number.isInteger(n) && !Number.isSafeInteger(n)) throw unsafe(value, column);
	return n;
}

/** A refusal of a value too large for a number to hold exactly. */
function unsafe(value: unknown, column: string): TypeError {
	return refusal(
		"number",
		column,
		`${kindOf(value)} outside the safe integer range, which a number cannot hold exactly: decode it with decode.bigint`,
	);
}

/** The built-in decoders. Each reads `null` and `undefined` as `null`. */
export const decode: {
	readonly bool: Decoder<boolean | null>;
	readonly instant: Decoder<Date | null>;
	readonly json: Decoder<unknown>;
	readonly bigint: Decoder<bigint | null>;
	readonly number: Decoder<number | null>;
} = Object.freeze({ bool, instant, json, bigint, number });

/**
 * A new row with the columns `spec` names decoded, and every other column as it was. A
 * column `spec` names that the row does not have is a `TypeError`.
 */
export function decodeRow<S extends Record<string, Decoder<unknown>>>(
	row: Row,
	spec: S,
): Row & { [K in keyof S]: ReturnType<S[K]> } {
	return decodeWith(row, entriesOf(spec), "decodeRow: the row") as Row & {
		[K in keyof S]: ReturnType<S[K]>;
	};
}

/** {@link decodeRow} over every row of `rows`: a new array of new rows. */
export function decodeRows<S extends Record<string, Decoder<unknown>>>(
	rows: readonly Row[],
	spec: S,
): Array<Row & { [K in keyof S]: ReturnType<S[K]> }> {
	if (!Array.isArray(rows)) {
		throw new TypeError(`decodeRows: rows must be an array, got ${kindOf(rows)}`);
	}
	const entries = entriesOf(spec);
	return rows.map(
		(row, i) =>
			decodeWith(row, entries, `decodeRows: row ${i}`) as Row & {
				[K in keyof S]: ReturnType<S[K]>;
			},
	);
}

/** The spec's own entries, each checked to be a function. */
function entriesOf(spec: unknown): [string, Decoder<unknown>][] {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new TypeError(`decode: the spec must be an object, got ${kindOf(spec)}`);
	}
	const entries = Object.entries(spec);
	for (const [column, decoder] of entries) {
		if (typeof decoder !== "function") {
			throw new TypeError(
				`decode: the spec's ${JSON.stringify(column)} must be a decoder function, got ${kindOf(decoder)}`,
			);
		}
	}
	return entries;
}

/** A copy of `row` with each column of `entries` decoded. */
function decodeWith(
	row: unknown,
	entries: readonly [string, Decoder<unknown>][],
	who: string,
): Row {
	if (typeof row !== "object" || row === null || Array.isArray(row)) {
		throw new TypeError(`${who} must be an object, got ${kindOf(row)}`);
	}
	const source = row as Row;
	const out: Row = { ...source };
	for (const [column, decoder] of entries) {
		if (!Object.hasOwn(source, column)) {
			throw new TypeError(
				`${who} has no column ${JSON.stringify(column)}, which the spec names`,
			);
		}
		out[column] = decoder(source[column], column);
	}
	return out;
}

function refusal(name: string, column: unknown, found: string): TypeError {
	const where =
		typeof column === "string" ? `column ${JSON.stringify(column)}` : "the value";
	return new TypeError(`decode.${name}: ${where} holds ${found}`);
}

/** The type of a value, as a refusal names it: "a string", "an array", "a Buffer". */
function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value !== "object") {
		return `${/^[aeiou]/.test(typeof value) ? "an" : "a"} ${typeof value}`;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto === Object.prototype || proto === null) return "an object";
	const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
	if (typeof name !== "string" || name === "") return "an object";
	return `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name}`;
}
