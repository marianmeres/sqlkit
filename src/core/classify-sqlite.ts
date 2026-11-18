/**
 * The SQLite classifier: which `SqlErrorKind` a SQLite driver's error is, and what its
 * message says about the constraint it refused.
 *
 * A pure function over `unknown`. It imports no driver: an error is read by its shape.
 * node:sqlite puts SQLite's extended result code on every error from the database as a
 * number, `errcode` (and `code: "ERR_SQLITE_ERROR"`, which says nothing more).
 *
 * A Durable Object's SQLite storage (workerd) carries no code field at all: its error is a
 * plain `Error` whose message ends with SQLite's code names, the primary one and, where
 * there is one, the extended one (`…: SQLITE_CONSTRAINT (extended:
 * SQLITE_CONSTRAINT_UNIQUE)`, `…: SQLITE_ERROR`). An error without a numeric `errcode` is
 * read from that tail: the most specific name picks the kind and the code, and the tail
 * is stripped before the subject below is read. An extended name the table here does not
 * know still picks its primary's kind, without a code. An error with neither did not come
 * from SQLite and is `unknown`.
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

/**
 * SQLite's result codes by name, as workerd names them in a message: every primary code,
 * and the extended codes of a constraint. Names are stable across SQLite releases.
 */
const CODE_OF_NAME: ReadonlyMap<string, number> = new Map<string, number>([
	["SQLITE_ERROR", 1],
	["SQLITE_INTERNAL", 2],
	["SQLITE_PERM", 3],
	["SQLITE_ABORT", 4],
	["SQLITE_BUSY", 5],
	["SQLITE_LOCKED", 6],
	["SQLITE_NOMEM", 7],
	["SQLITE_READONLY", 8],
	["SQLITE_INTERRUPT", 9],
	["SQLITE_IOERR", 10],
	["SQLITE_CORRUPT", 11],
	["SQLITE_NOTFOUND", 12],
	["SQLITE_FULL", 13],
	["SQLITE_CANTOPEN", 14],
	["SQLITE_PROTOCOL", 15],
	["SQLITE_EMPTY", 16],
	["SQLITE_SCHEMA", 17],
	["SQLITE_TOOBIG", 18],
	["SQLITE_CONSTRAINT", 19],
	["SQLITE_MISMATCH", 20],
	["SQLITE_MISUSE", 21],
	["SQLITE_NOLFS", 22],
	["SQLITE_AUTH", 23],
	["SQLITE_FORMAT", 24],
	["SQLITE_RANGE", 25],
	["SQLITE_NOTADB", 26],
	["SQLITE_NOTICE", 27],
	["SQLITE_WARNING", 28],
	["SQLITE_CONSTRAINT_CHECK", 275],
	["SQLITE_CONSTRAINT_COMMITHOOK", 531],
	["SQLITE_CONSTRAINT_FOREIGNKEY", 787],
	["SQLITE_CONSTRAINT_FUNCTION", 1043],
	["SQLITE_CONSTRAINT_NOTNULL", 1299],
	["SQLITE_CONSTRAINT_PRIMARYKEY", 1555],
	["SQLITE_CONSTRAINT_TRIGGER", 1811],
	["SQLITE_CONSTRAINT_UNIQUE", 2067],
	["SQLITE_CONSTRAINT_VTAB", 2323],
	["SQLITE_CONSTRAINT_ROWID", 2579],
	["SQLITE_CONSTRAINT_PINNED", 2835],
	["SQLITE_CONSTRAINT_DATATYPE", 3091],
]);

/** The code names a message ends with when the error has no `errcode`: workerd's form. */
const CODE_TAIL = /: (SQLITE_[A-Z_]+)(?: \(extended: (SQLITE_[A-Z_]+)\))?$/;

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
	let message = typeof fields.message === "string" ? fields.message : undefined;
	let info: SqlErrorInfo;
	if (typeof errcode === "number" && Number.isInteger(errcode)) {
		info = { kind: kindOfCode(errcode), code: String(errcode) };
	} else {
		const tail = message === undefined ? null : CODE_TAIL.exec(message);
		if (message === undefined || tail === null) return { kind: "unknown" };
		info = fromCodeNames(tail[1] ?? "", tail[2]);
		message = message.slice(0, tail.index);
	}
	const subject =
		message === undefined ? undefined : SUBJECT.exec(message)?.[1]?.trim();
	if (subject === undefined || subject === "") return info;

	if (info.kind === "unique") {
		const index = INDEX_SUBJECT.exec(subject);
		if (index !== null) {
			info.constraint = index[1];
			return info;
		}
		Object.assign(info, tableAndColumns(subject));
	} else if (info.kind === "not_null") {
		Object.assign(info, tableAndColumns(subject));
	} else if (info.kind === "check" && IDENTIFIER.test(subject)) {
		info.constraint = subject;
	}
	return info;
}

/** The kind of an extended result code, or of its primary code (`code & 0xff`). */
function kindOfCode(code: number): SqlErrorKind {
	return KIND_OF_ERRCODE.get(code) ?? KIND_OF_PRIMARY.get(code & 0xff) ?? "unknown";
}

/**
 * The kind and the code of a message's code names: the extended name where there is one,
 * else the primary. An extended name not in the table falls back to its primary's kind,
 * with no code, since the number it stands for is not known here.
 */
function fromCodeNames(primary: string, extended: string | undefined): SqlErrorInfo {
	const code = CODE_OF_NAME.get(extended ?? primary);
	if (code !== undefined) return { kind: kindOfCode(code), code: String(code) };
	const fallback = CODE_OF_NAME.get(primary);
	return { kind: fallback === undefined ? "unknown" : kindOfCode(fallback) };
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
