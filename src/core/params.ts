/**
 * The one parameter rule: what a JavaScript value binds as, applied by every adapter
 * before a value reaches a driver, so a value means the same thing on every database.
 *
 * | Value                                      | `pg`                     | `sqlite`                                |
 * | ------------------------------------------ | ------------------------ | --------------------------------------- |
 * | `undefined`, `null`                        | `NULL`                   | `NULL`                                  |
 * | `boolean`                                  | as is                    | `1` / `0`                               |
 * | `Date`                                     | as is                    | `toISOString()`                         |
 * | `bigint`, `number`, `string`, `Uint8Array` | as is                    | as is                                   |
 * | plain object                               | `JSON.stringify`         | `JSON.stringify`                        |
 * | array                                      | as is (a Postgres array) | `TypeError`: use `json()` or `inList()` |
 * | anything else                              | `TypeError`              | `TypeError`                             |
 *
 * It is applied before the driver, not left to it, because the drivers disagree and some
 * do so silently: node:sqlite binds a `Date` as `NULL` and reads an array as a bag of named
 * parameters.
 *
 * A plain object is one whose prototype is `Object.prototype` or `null`. Any other object
 * (a `Map`, a class instance, a typed array other than `Uint8Array`) is "anything else":
 * `JSON.stringify` would turn a `Map` into `{}` and lose it, so it is refused rather than
 * guessed at; `json(value)` states the intent when JSON text is what is wanted. An invalid
 * `Date` is refused on both dialects, and so is a fragment, which belongs in a template
 * (`sql\`… ${fragment} …\``), not in a parameter list.
 *
 * Runtime-neutral: imports only the core.
 */

import type { DialectName } from "./contract.ts";
import { isSql } from "./sql.ts";

/** One value, bound by the parameter rule for `dialect`. */
export function normalizeParam(value: unknown, dialect: DialectName): unknown {
	if (dialect !== "pg" && dialect !== "sqlite") {
		throw new TypeError(`unknown dialect ${JSON.stringify(dialect)}`);
	}
	if (value === undefined || value === null) return null;
	switch (typeof value) {
		case "string":
		case "number":
		case "bigint":
			return value;
		case "boolean":
			return dialect === "sqlite" ? (value ? 1 : 0) : value;
		case "object":
			return normalizeObject(value, dialect);
		default:
			throw new TypeError(`cannot bind a ${typeof value} as a parameter`);
	}
}

/** Every value of `params`, bound by the parameter rule. A new array; the input is kept. */
export function normalizeParams(
	params: readonly unknown[],
	dialect: DialectName,
): unknown[] {
	if (!Array.isArray(params)) {
		throw new TypeError("parameters must be an array");
	}
	const out: unknown[] = [];
	for (const value of params) out.push(normalizeParam(value, dialect));
	return out;
}

function normalizeObject(value: object, dialect: DialectName): unknown {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new TypeError("cannot bind an invalid Date as a parameter");
		}
		return dialect === "sqlite" ? value.toISOString() : value;
	}
	if (value instanceof Uint8Array) return value;
	if (Array.isArray(value)) {
		if (dialect === "pg") return value;
		throw new TypeError(
			"sqlite has no array type: bind json(array) for JSON text, or expand it with inList()",
		);
	}
	if (isSql(value)) {
		throw new TypeError(
			"a fragment cannot be a parameter: interpolate it into a sql`` template instead",
		);
	}
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
		const what =
			typeof name !== "string" || name === ""
				? "this object"
				: `${/^[AEIOU]/.test(name) ? "an" : "a"} ${name}`;
		throw new TypeError(
			`cannot bind ${what} as a parameter: only a plain object binds (as JSON text); convert it first`,
		);
	}
	const text: string | undefined = JSON.stringify(value);
	if (text === undefined) {
		throw new TypeError("cannot bind an object that has no JSON representation");
	}
	return text;
}
