// The error classes (plan doc 01 #3, D07, D17): `instanceof` on every class, `retryable` on
// every kind, the fields as given, and the constructor's refusals. No database: the errors
// are built by `toSqlError` from a classifier that answers the kind under test, which is
// how every adapter builds them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	BusyError,
	CheckViolationError,
	ConnectionError,
	DeadlockError,
	ForeignKeyViolationError,
	NotNullViolationError,
	ReadOnlyError,
	SerializationError,
	SqlError,
	type SqlErrorKind,
	TransactionAbortedError,
	toSqlError,
	UniqueViolationError,
} from "../../src/mod.ts";

/** Every kind, the class `toSqlError` builds for it, and whether it is retryable. */
const KINDS: [SqlErrorKind, typeof SqlError, string, boolean][] = [
	["unique", UniqueViolationError, "UniqueViolationError", false],
	["foreign_key", ForeignKeyViolationError, "ForeignKeyViolationError", false],
	["not_null", NotNullViolationError, "NotNullViolationError", false],
	["check", CheckViolationError, "CheckViolationError", false],
	["serialization", SerializationError, "SerializationError", true],
	["deadlock", DeadlockError, "DeadlockError", true],
	["busy", BusyError, "BusyError", true],
	["connection", ConnectionError, "ConnectionError", true],
	["read_only", ReadOnlyError, "ReadOnlyError", false],
	["aborted", TransactionAbortedError, "TransactionAbortedError", false],
	["unknown", SqlError, "SqlError", false],
];

function errorOf(kind: SqlErrorKind): SqlError {
	return toSqlError(new Error(`driver says ${kind}`), "pg", () => ({ kind }));
}

describe("unit/errors: classes", () => {
	test("every kind of SqlErrorKind has a row here", () => {
		// The type has eleven members; a twelfth without a class would build a bare SqlError.
		assert.equal(new Set(KINDS.map(([kind]) => kind)).size, 11);
	});

	for (const [kind, Class, name] of KINDS) {
		test(`${kind} is a ${name}, a SqlError and an Error, and no other class`, () => {
			const error = errorOf(kind);
			assert.ok(error instanceof Class);
			assert.ok(error instanceof SqlError);
			assert.ok(error instanceof Error);
			assert.equal(Object.getPrototypeOf(error), Class.prototype);
			for (const [, Other] of KINDS) {
				if (Other === Class || Other === SqlError) continue;
				assert.equal(error instanceof Other, false, `also a ${Other.name}`);
			}
			assert.equal(error.kind, kind);
		});

		test(`${kind}: the name is ${name}, on the prototype, and leads the stack`, () => {
			const error = errorOf(kind);
			assert.equal(error.name, name);
			assert.equal(Object.hasOwn(error, "name"), false);
			assert.equal(String(error), `${name}: driver says ${kind}`);
			assert.match(
				String(error.stack),
				new RegExp(`^${name}: driver says ${kind}\\n`),
			);
		});
	}

	test("a subclass constructed directly is that class too", () => {
		const error = new DeadlockError("deadlock detected", "pg", {
			kind: "deadlock",
			code: "40P01",
		});
		assert.ok(error instanceof DeadlockError);
		assert.ok(error instanceof SqlError);
		assert.equal(error.name, "DeadlockError");
		assert.equal(error.retryable, true);
	});
});

describe("unit/errors: retryable", () => {
	for (const [kind, , , retryable] of KINDS) {
		test(`${kind} is ${retryable ? "" : "not "}retryable`, () => {
			assert.equal(errorOf(kind).retryable, retryable);
		});
	}

	test("retryable is read from the kind, not stored on the instance", () => {
		const error = errorOf("busy");
		assert.equal(Object.hasOwn(error, "retryable"), false);
		assert.equal(Object.keys(error).includes("retryable"), false);
	});
});

describe("unit/errors: fields", () => {
	test("each field is what the classifier reported", () => {
		const cause = new Error("NOT NULL constraint failed: t.n");
		const error = new SqlError(
			cause.message,
			"sqlite",
			{ kind: "not_null", code: "1299", table: "t", columns: ["n"] },
			cause,
		);
		assert.equal(error.message, "NOT NULL constraint failed: t.n");
		assert.equal(error.dialect, "sqlite");
		assert.equal(error.kind, "not_null");
		assert.equal(error.code, "1299");
		assert.equal(error.constraint, undefined);
		assert.equal(error.table, "t");
		assert.deepEqual(error.columns, ["n"]);
		assert.equal(error.cause, cause);
	});

	test("a field the database did not report is undefined", () => {
		const error = new SqlError("x", "pg", { kind: "unknown" });
		assert.equal(error.code, undefined);
		assert.equal(error.constraint, undefined);
		assert.equal(error.table, undefined);
		assert.equal(error.columns, undefined);
		assert.equal(Object.hasOwn(error, "cause"), false, "no cause given, none set");
	});

	test("columns is a frozen copy: neither side can change the other", () => {
		const columns = ["a", "b"];
		const error = new SqlError("x", "sqlite", { kind: "unique", columns });
		columns.push("c");
		assert.deepEqual(error.columns, ["a", "b"]);
		assert.equal(Object.isFrozen(error.columns), true);
	});
});

describe("unit/errors: the constructor refuses what is a mistake", () => {
	test("an unknown dialect is a TypeError", () => {
		assert.throws(
			() => new SqlError("x", "mysql" as "pg", { kind: "unknown" }),
			(error: unknown) =>
				error instanceof TypeError &&
				/unknown dialect "mysql"/.test(error.message),
		);
	});

	test("an unknown kind, or no info at all, is a TypeError", () => {
		for (const info of [{ kind: "oops" }, {}, null, undefined]) {
			assert.throws(
				() => new SqlError("x", "pg", info as unknown as { kind: SqlErrorKind }),
				(error: unknown) =>
					error instanceof TypeError && /unknown kind/.test(error.message),
				JSON.stringify(info),
			);
		}
	});
});
