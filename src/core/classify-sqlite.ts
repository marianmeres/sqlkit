/**
 * The SQLite classifier: which `SqlErrorKind` a SQLite driver's error is, and what its
 * message says about the constraint it refused.
 *
 * A pure function over `unknown`. It imports no driver: an error is read by its shape.
 * node:sqlite puts SQLite's extended result code on every error from the database as a
 * number, `errcode` (and `code: "ERR_SQLITE_ERROR"`, which says nothing more). An error
 * without a numeric `errcode` did not come from SQLite and is `unknown`.
 *
 * SQLite reports no constraint fields, only a message, so the subject is parsed from it:
 *
 * | Kind        | Message                                            | Read as                        |
 * | ----------- | -------------------------------------------------- | ------------------------------ |
 * | unique      | `UNIQUE constraint failed: t.a, t.b`               | `table` and `columns`          |
 * | unique      | `UNIQUE constraint failed: index 'name'`           | `constraint` (an expression index) |
 * | not_null    | `NOT NULL constraint failed: t.c`                  | `table` and `columns`          |
 * | check       | `CHECK constraint failed: name`                    | `constraint`                   |
 * | check       | `CHECK constraint failed: n > 0`                   | nothing (an unnamed `CHECK`)   |
 * | foreign_key | `FOREIGN KEY constraint failed`                    | nothing: SQLite names nothing  |
 *
 * Two readings are as good as the message allows and no better. A table or column name
 * with a dot in it is split at its first dot. An unnamed `CHECK` is reported by its
 * expression's text, so one whose whole expression is a single identifier (`check
 * (active)`) reads as a constraint of that name.
 *
 * Runtime-neutral: imports only the core's types.
 */

import type { SqlErrorInfo, SqlErrorKind } from "./errors.ts";

/** Extended result codes that decide a kind on their own. */
const KIND_OF_ERRCODE: ReadonlyMap<number, SqlErrorKind> = new Map<number, SqlErrorKind>([
	[2067, "unique"], // SQLITE_CONSTRAINT_UNIQUE
	[1555, "unique"], // SQLITE_CONSTRAINT_PRIMARYKEY
	[787, "foreign_key"], // SQLITE_CONSTRAINT_FOREIGNKEY
	[1299, "not_null"], // SQLITE_CONSTRAINT_NOTNULL
	[275, "check"], // SQLITE_CONSTRAINT_CHECK
]);

/** Primary result codes (`errcode & 0xff`) that decide a kind, with every extension. */
const KIND_OF_PRIMARY: ReadonlyMap<number, SqlErrorKind> = new Map<number, SqlErrorKind>([
	[5, "busy"], // SQLITE_BUSY
	[6, "busy"], // SQLITE_LOCKED
	[8, "read_only"], // SQLITE_READONLY
]);

/** `UNIQUE constraint failed: <subject>`, and the not-null and check forms. */
const SUBJECT = /^(?:UNIQUE|NOT NULL|CHECK) constraint failed: (.+)$/s;

/** `index 'name'`: what SQLite reports for an index on an expression. */
const INDEX_SUBJECT = /^index '(.+)'$/s;

/** A bare identifier: what a named `CHECK` is reported as, and an expression is not. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Which kind a SQLite driver's error is, and what its message said about the refusal. */
export function classifySqlite(error: unknown): SqlErrorInfo {
	if (typeof error !== "object" || error === null) return { kind: "unknown" };
	const fields = error as Record<string, unknown>;
	const errcode = fields.errcode;
	if (typeof errcode !== "number" || !Number.isInteger(errcode)) {
		return { kind: "unknown" };
	}
	const kind =
		KIND_OF_ERRCODE.get(errcode) ?? KIND_OF_PRIMARY.get(errcode & 0xff) ?? "unknown";
	const info: SqlErrorInfo = { kind, code: String(errcode) };
	const subject =
		typeof fields.message === "string"
			? SUBJECT.exec(fields.message)?.[1]?.trim()
			: undefined;
	if (subject === undefined || subject === "") return info;

	if (kind === "unique") {
		const index = INDEX_SUBJECT.exec(subject);
		if (index !== null) {
			info.constraint = index[1];
			return info;
		}
		Object.assign(info, tableAndColumns(subject));
	} else if (kind === "not_null") {
		Object.assign(info, tableAndColumns(subject));
	} else if (kind === "check" && IDENTIFIER.test(subject)) {
		info.constraint = subject;
	}
	return info;
}

/** `t.a, t.b` as `{ table: "t", columns: ["a", "b"] }`; nothing when it does not read so. */
function tableAndColumns(subject: string): Pick<SqlErrorInfo, "table" | "columns"> {
	let table: string | undefined;
	const columns: string[] = [];
	for (const qualified of subject.split(", ")) {
		const dot = qualified.indexOf(".");
		if (dot <= 0 || dot === qualified.length - 1) return {};
		const owner = qualified.slice(0, dot);
		if (table !== undefined && owner !== table) return {};
		table = owner;
		columns.push(qualified.slice(dot + 1));
	}
	return table === undefined ? {} : { table, columns };
}
