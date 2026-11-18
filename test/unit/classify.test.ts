// The two classifiers (plan doc 01 #3): one fabricated error per cell of the kind table and
// of the field table, a non-object and an unrelated Error classified `unknown`, and
// toSqlError shown idempotent and keeping `cause`.
//
// The fabricated shapes are the real ones. node:sqlite's were recorded on Node 26.13.1:
// `code: "ERR_SQLITE_ERROR"`, a numeric `errcode`, `errstr`, and the message. Postgres's
// fields were recorded on Postgres 18.6, where a not-null violation names its table and
// column but no constraint. node-postgres's code-less messages are those of pg 8.23.1 and
// pg-pool; pinned here, since a reword upstream would otherwise turn a lost connection
// into `unknown` silently. Real violations on each adapter are the errors conformance
// body's job (T08).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	classifyPg,
	classifySqlite,
	type SqlErrorInfo,
	type SqlErrorKind,
	toSqlError,
	UniqueViolationError,
} from "../../src/mod.ts";

/** A node-postgres `DatabaseError` as the server reports it. */
function pgError(code: string, message: string, fields: Record<string, string> = {}) {
	return Object.assign(new Error(message), { severity: "ERROR", code, ...fields });
}

/** A Node system error, as node-postgres passes one on for a socket. */
function systemError(code: string) {
	return Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), {
		code,
		errno: -1,
		syscall: "connect",
	});
}

/** A node:sqlite error, exactly as Node 26.13.1 throws one. */
function sqliteError(errcode: number, message: string, errstr = "constraint failed") {
	return Object.assign(new Error(message), {
		code: "ERR_SQLITE_ERROR",
		errcode,
		errstr,
	});
}

describe("unit/classify: pg kinds", () => {
	const cases: [SqlErrorKind, string][] = [
		["unique", "23505"],
		["foreign_key", "23503"],
		["not_null", "23502"],
		["check", "23514"],
		["serialization", "40001"],
		["deadlock", "40P01"],
		["busy", "55P03"],
		["read_only", "25006"],
		["aborted", "25P02"],
		["connection", "08000"],
		["connection", "08001"],
		["connection", "08003"],
		["connection", "08004"],
		["connection", "08006"],
		["connection", "08007"],
		["connection", "08P01"],
		["connection", "57P01"],
		["connection", "57P02"],
		["connection", "57P03"],
		["connection", "53300"],
		["unknown", "42P01"], // undefined_table
		["unknown", "42601"], // syntax_error
		["unknown", "22012"], // division_by_zero
		["unknown", "57014"], // query_canceled: not a lost connection
		["unknown", "0800"], // not a SQLSTATE: class 08 is five characters
	];
	for (const [kind, code] of cases) {
		test(`${code} is ${kind}, and the code is kept`, () => {
			const info = classifyPg(pgError(code, "message"));
			assert.equal(info.kind, kind);
			assert.equal(info.code, code);
		});
	}

	for (const code of [
		"ECONNREFUSED",
		"ECONNRESET",
		"ETIMEDOUT",
		"ENOTFOUND",
		"EPIPE",
		"EAI_AGAIN",
	]) {
		test(`Node's ${code} is connection`, () => {
			assert.deepEqual(classifyPg(systemError(code)), { kind: "connection", code });
		});
	}

	// Pinned: node-postgres says these in words only, with no code.
	for (const message of [
		"timeout exceeded when trying to connect", // pg-pool, connectionTimeoutMillis
		"Connection terminated unexpectedly", // pg client, the socket ended
		"Connection terminated", // pg client, ended while queries were queued
		"Connection terminated due to connection timeout", // pg-pool
	]) {
		test(`"${message}" with no code is connection`, () => {
			assert.deepEqual(classifyPg(new Error(message)), { kind: "connection" });
		});
	}

	test("those words beside a code do not override it", () => {
		const info = classifyPg(pgError("42601", "Connection terminated"));
		assert.equal(info.kind, "unknown");
	});

	test("a code that is not a string is no code", () => {
		assert.deepEqual(classifyPg(Object.assign(new Error("x"), { code: 23505 })), {
			kind: "unknown",
		});
	});
});

describe("unit/classify: pg fields", () => {
	test("unique: constraint and table; no columns", () => {
		const info = classifyPg(
			pgError("23505", 'duplicate key value violates unique constraint "t_c_key"', {
				detail: "Key (c)=(x) already exists.",
				schema: "app",
				table: "t",
				constraint: "t_c_key",
			}),
		);
		assert.deepEqual(info, {
			kind: "unique",
			code: "23505",
			constraint: "t_c_key",
			table: "t",
		});
	});

	test("foreign key: constraint and table; no columns", () => {
		const info = classifyPg(
			pgError(
				"23503",
				'insert or update on table "t" violates foreign key constraint "t_pid_fkey"',
				{ schema: "app", table: "t", constraint: "t_pid_fkey" },
			),
		);
		assert.deepEqual(info, {
			kind: "foreign_key",
			code: "23503",
			constraint: "t_pid_fkey",
			table: "t",
		});
	});

	test("not null: table and the column; Postgres names no constraint", () => {
		const info = classifyPg(
			pgError(
				"23502",
				'null value in column "n" of relation "t" violates not-null constraint',
				{ schema: "app", table: "t", column: "n" },
			),
		);
		assert.deepEqual(info, {
			kind: "not_null",
			code: "23502",
			table: "t",
			columns: ["n"],
		});
	});

	test("check: constraint and table; no columns", () => {
		const info = classifyPg(
			pgError(
				"23514",
				'new row for relation "t" violates check constraint "m_pos"',
				{
					schema: "app",
					table: "t",
					constraint: "m_pos",
				},
			),
		);
		assert.deepEqual(info, {
			kind: "check",
			code: "23514",
			constraint: "m_pos",
			table: "t",
		});
	});

	test("an empty field is no field", () => {
		const info = classifyPg(pgError("23505", "x", { constraint: "", table: "" }));
		assert.deepEqual(info, { kind: "unique", code: "23505" });
	});
});

describe("unit/classify: sqlite kinds", () => {
	const cases: [SqlErrorKind, number, string, string?][] = [
		["unique", 2067, "UNIQUE constraint failed: t.c"],
		["unique", 1555, "UNIQUE constraint failed: t.id"], // a primary key
		["foreign_key", 787, "FOREIGN KEY constraint failed"],
		["not_null", 1299, "NOT NULL constraint failed: t.c"],
		["check", 275, "CHECK constraint failed: n > 0"],
		["busy", 5, "database is locked", "database is locked"], // SQLITE_BUSY
		["busy", 261, "database is locked", "database is locked"], // BUSY_RECOVERY
		["busy", 517, "database is locked", "database is locked"], // BUSY_SNAPSHOT
		["busy", 6, "database table is locked", "database table is locked"], // LOCKED
		["busy", 262, "database table is locked", "database table is locked"], // LOCKED_SHAREDCACHE
		[
			"read_only",
			8,
			"attempt to write a readonly database",
			"attempt to write a readonly database",
		],
		[
			"read_only",
			1032, // READONLY_DBMOVED
			"attempt to write a readonly database",
			"attempt to write a readonly database",
		],
		["unknown", 1, "no such table: nope", "SQL logic error"],
		["unknown", 1, 'near "selec": syntax error', "SQL logic error"],
		["unknown", 19, "constraint failed"], // a bare SQLITE_CONSTRAINT
		["unknown", 1811, "rejected by a trigger"], // CONSTRAINT_TRIGGER: 19 | 7 << 8
		["unknown", 13, "database or disk is full", "database or disk is full"],
	];
	for (const [kind, errcode, message, errstr] of cases) {
		test(`${errcode} (${message}) is ${kind}, and the code is kept in decimal`, () => {
			const info = classifySqlite(sqliteError(errcode, message, errstr));
			assert.equal(info.kind, kind);
			assert.equal(info.code, String(errcode));
		});
	}

	test("an error without a numeric errcode did not come from SQLite", () => {
		// What node:sqlite throws for a closed handle: a Node error, no errcode.
		const closed = Object.assign(new Error("database is not open"), {
			code: "ERR_INVALID_STATE",
		});
		assert.deepEqual(classifySqlite(closed), { kind: "unknown" });
		assert.deepEqual(
			classifySqlite(Object.assign(new Error("x"), { errcode: "2067" })),
			{ kind: "unknown" },
		);
		assert.deepEqual(
			classifySqlite(Object.assign(new Error("x"), { errcode: 2067.5 })),
			{
				kind: "unknown",
			},
		);
	});
});

describe("unit/classify: sqlite fields", () => {
	const cases: [string, ReturnType<typeof sqliteError>, SqlErrorInfo][] = [
		[
			"unique, one column: table and columns",
			sqliteError(2067, "UNIQUE constraint failed: t.c"),
			{ kind: "unique", code: "2067", table: "t", columns: ["c"] },
		],
		[
			"unique, several columns: table and every column, in order",
			sqliteError(2067, "UNIQUE constraint failed: t.a, t.b"),
			{ kind: "unique", code: "2067", table: "t", columns: ["a", "b"] },
		],
		[
			"unique, a primary key: table and its column",
			sqliteError(1555, "UNIQUE constraint failed: t.id"),
			{ kind: "unique", code: "1555", table: "t", columns: ["id"] },
		],
		[
			"unique, an expression index: the index as constraint, nothing else",
			sqliteError(2067, "UNIQUE constraint failed: index 't_expr'"),
			{ kind: "unique", code: "2067", constraint: "t_expr" },
		],
		[
			"not null: table and the column",
			sqliteError(1299, "NOT NULL constraint failed: t.n"),
			{ kind: "not_null", code: "1299", table: "t", columns: ["n"] },
		],
		[
			"check, named: the constraint",
			sqliteError(275, "CHECK constraint failed: m_pos"),
			{ kind: "check", code: "275", constraint: "m_pos" },
		],
		[
			"check, unnamed: its expression is no constraint",
			sqliteError(275, "CHECK constraint failed: n > 0"),
			{ kind: "check", code: "275" },
		],
		[
			"check, named with a space: not told from an expression, so no constraint",
			sqliteError(275, "CHECK constraint failed: my check"),
			{ kind: "check", code: "275" },
		],
		[
			"foreign key: SQLite names nothing",
			sqliteError(787, "FOREIGN KEY constraint failed"),
			{ kind: "foreign_key", code: "787" },
		],
		[
			"a dotted name is split at its first dot",
			sqliteError(2067, "UNIQUE constraint failed: we.ird.c.d"),
			{ kind: "unique", code: "2067", table: "we", columns: ["ird.c.d"] },
		],
		[
			"columns of two tables do not read as one table",
			sqliteError(2067, "UNIQUE constraint failed: t.a, u.b"),
			{ kind: "unique", code: "2067" },
		],
		[
			"a message that does not read as the form: no fields",
			sqliteError(2067, "constraint failed"),
			{ kind: "unique", code: "2067" },
		],
	];
	for (const [name, error, expected] of cases) {
		test(name, () => {
			assert.deepEqual(classifySqlite(error), expected);
		});
	}
});

/** A Durable Object's SQLite error, as workerd throws one: a plain Error, a message only. */
function workerdError(message: string): Error {
	return new Error(message);
}

describe("unit/classify: sqlite errors read from the message (Durable Objects)", () => {
	// F11's five messages, character for character (workerd 1.20260730.1), and what the
	// classifier reads from each: the code names pick kind and code, the subject is read
	// once the tail is stripped. The rest are the same paths through other code names.
	const cases: [string, string, SqlErrorInfo][] = [
		[
			"unique (F11)",
			"UNIQUE constraint failed: child.code: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
			{ kind: "unique", code: "2067", table: "child", columns: ["code"] },
		],
		[
			"foreign key (F11)",
			"FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
			{ kind: "foreign_key", code: "787" },
		],
		[
			"not null (F11)",
			"NOT NULL constraint failed: child.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)",
			{ kind: "not_null", code: "1299", table: "child", columns: ["name"] },
		],
		[
			"check (F11)",
			"CHECK constraint failed: qty_positive: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
			{ kind: "check", code: "275", constraint: "qty_positive" },
		],
		[
			"syntax (F11): a primary name alone",
			'near "selec": syntax error at offset 0: SQLITE_ERROR',
			{ kind: "unknown", code: "1" },
		],
		[
			"a primary key",
			"UNIQUE constraint failed: item.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
			{ kind: "unique", code: "1555", table: "item", columns: ["id"] },
		],
		[
			"an expression index",
			"UNIQUE constraint failed: index 'item_email_lower': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
			{ kind: "unique", code: "2067", constraint: "item_email_lower" },
		],
		[
			"an unnamed check: its expression is no constraint",
			"CHECK constraint failed: n > 0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
			{ kind: "check", code: "275" },
		],
		[
			"a missing table",
			"no such table: nope: SQLITE_ERROR",
			{ kind: "unknown", code: "1" },
		],
		[
			"a statement workerd does not authorize",
			"not authorized: SQLITE_AUTH",
			{ kind: "unknown", code: "23" },
		],
		[
			"a primary code with a kind of its own",
			"database is locked: SQLITE_BUSY",
			{ kind: "busy", code: "5" },
		],
		[
			"an extended name not in the table: the primary's kind, no code",
			"database is locked: SQLITE_BUSY (extended: SQLITE_BUSY_SOMETHING_NEW)",
			{ kind: "busy" },
		],
		[
			"a name SQLite does not have: unknown, no code",
			"something: SQLITE_NO_SUCH_CODE",
			{ kind: "unknown" },
		],
	];
	for (const [name, message, expected] of cases) {
		test(name, () => {
			assert.deepEqual(classifySqlite(workerdError(message)), expected);
		});
	}

	test("the names are read only as a message's tail", () => {
		for (const message of [
			"SQLITE_CONSTRAINT_UNIQUE",
			"UNIQUE constraint failed: t.c: SQLITE_CONSTRAINT_UNIQUE and more",
			"UNIQUE constraint failed: t.c (extended: SQLITE_CONSTRAINT_UNIQUE)",
			"failed: sqlite_constraint",
		]) {
			assert.deepEqual(classifySqlite(workerdError(message)), { kind: "unknown" });
		}
	});

	test("a numeric errcode wins over the message", () => {
		const error = Object.assign(
			new Error("UNIQUE constraint failed: t.c: SQLITE_CONSTRAINT_CHECK"),
			{ errcode: 2067 },
		);
		assert.equal(classifySqlite(error).kind, "unique");
		assert.equal(classifySqlite(error).code, "2067");
	});

	test("the Postgres classifier does not read the SQLite tail", () => {
		const error = workerdError(
			"UNIQUE constraint failed: t.c: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
		);
		assert.deepEqual(classifyPg(error), { kind: "unknown" });
	});
});

describe("unit/classify: what is not a driver error", () => {
	test("a non-object is unknown to both", () => {
		for (const value of [undefined, null, "boom", 42, true, Symbol("s"), 10n]) {
			assert.deepEqual(classifyPg(value), { kind: "unknown" }, String(value));
			assert.deepEqual(classifySqlite(value), { kind: "unknown" }, String(value));
		}
	});

	test("an unrelated Error is unknown to both", () => {
		for (const error of [new Error("boom"), new TypeError("x is not a function")]) {
			assert.deepEqual(classifyPg(error), { kind: "unknown" });
			assert.deepEqual(classifySqlite(error), { kind: "unknown" });
		}
	});

	test("each classifier reads only its own database's shape", () => {
		assert.equal(
			classifyPg(sqliteError(2067, "UNIQUE constraint failed: t.c")).kind,
			"unknown",
		);
		assert.equal(classifySqlite(pgError("23505", "duplicate key")).kind, "unknown");
	});
});

describe("unit/classify: toSqlError", () => {
	test("builds the class of the kind, with the driver's message and error", () => {
		const driverError = pgError(
			"23505",
			'duplicate key value violates unique constraint "k"',
			{
				table: "t",
				constraint: "k",
			},
		);
		const error = toSqlError(driverError, "pg", classifyPg);
		assert.ok(error instanceof UniqueViolationError);
		assert.equal(error.message, driverError.message);
		assert.equal(error.cause, driverError);
		assert.equal(error.dialect, "pg");
		assert.equal(error.kind, "unique");
		assert.equal(error.code, "23505");
		assert.equal(error.constraint, "k");
		assert.equal(error.table, "t");
		assert.equal(error.columns, undefined);
	});

	test("keeps the cause untouched", () => {
		const driverError = sqliteError(1299, "NOT NULL constraint failed: t.n");
		const before = { ...driverError, message: driverError.message };
		const error = toSqlError(driverError, "sqlite", classifySqlite);
		assert.equal(error.cause, driverError);
		assert.deepEqual({ ...driverError, message: driverError.message }, before);
		assert.equal(Object.getPrototypeOf(driverError), Error.prototype);
		assert.deepEqual(error.columns, ["n"]);
	});

	test("is idempotent: a SqlError passes through as the same object", () => {
		const once = toSqlError(
			sqliteError(787, "FOREIGN KEY constraint failed"),
			"sqlite",
			classifySqlite,
		);
		let called = false;
		const twice = toSqlError(once, "pg", () => {
			called = true;
			return { kind: "unknown" };
		});
		assert.equal(twice, once);
		assert.equal(called, false, "a SqlError is not classified again");
		assert.equal(twice.dialect, "sqlite");
	});

	test("something thrown that is not an Error still becomes one, kept as cause", () => {
		const fromString = toSqlError("boom", "pg", classifyPg);
		assert.equal(fromString.kind, "unknown");
		assert.equal(fromString.message, "boom");
		assert.equal(fromString.cause, "boom");

		const shaped = { message: "shaped", code: "40P01" };
		const fromObject = toSqlError(shaped, "pg", classifyPg);
		assert.equal(fromObject.kind, "deadlock");
		assert.equal(fromObject.message, "shaped");
		assert.equal(fromObject.cause, shaped);

		const bare = Object.create(null) as object;
		assert.equal(toSqlError(bare, "pg", classifyPg).message, "unknown error");
	});

	test("a classifier that answers a kind no class has is a TypeError", () => {
		assert.throws(
			() =>
				toSqlError(new Error("x"), "pg", () => ({
					kind: "nonsense" as SqlErrorKind,
				})),
			(error: unknown) =>
				error instanceof TypeError && /unknown kind/.test(error.message),
		);
	});
});
