// The error classes (plan doc 01 #3, D07, D17): `instanceof` on every class, `retryable` on
// every kind, the fields as given, and the constructor's refusals. No database: the errors
// are built by `toSqlError` from a classifier that answers the kind under test, which is
// how every adapter builds them.
//
// And the classes across two copies of the package in one process (backlog T34): the
// module is loaded a second time, under another URL, which is what an app whose
// dependencies ask for two versions of the package runs.
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
	withRetry,
} from "../../src/mod.ts";

/**
 * A second copy of the errors module: the same file under another URL is another module,
 * with classes of its own. The specifier is built at run time, so only its type is the
 * first copy's.
 */
const copyUrl = new URL("../../src/core/errors.ts?copy=2", import.meta.url).href;
const other = (await import(copyUrl)) as typeof import("../../src/core/errors.ts");

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

describe("unit/errors: across two copies of the package", () => {
	/** An error of `kind`, as the other copy's adapter would throw it. */
	const foreign = (kind: SqlErrorKind): SqlError =>
		other.toSqlError(
			Object.assign(new Error(`driver says ${kind}`), { code: "X" }),
			"pg",
			() => ({ kind, code: "X" }),
		);

	test("the second copy is another module, with classes of its own", () => {
		assert.notEqual(other.SqlError, SqlError);
		assert.notEqual(other.UniqueViolationError, UniqueViolationError);
		// By the prototype chain alone, one copy's error is not the other's.
		assert.equal(
			Object.prototype.isPrototypeOf.call(SqlError.prototype, foreign("unique")),
			false,
		);
	});

	for (const [kind, Class, name] of KINDS) {
		test(`the other copy's ${kind} error is a ${name} here, and no other class`, () => {
			const error = foreign(kind);
			assert.ok(error instanceof SqlError);
			assert.ok(error instanceof Class);
			for (const [, Other] of KINDS) {
				if (Other === Class || Other === SqlError) continue;
				assert.equal(error instanceof Other, false, `also a ${Other.name}`);
			}
			// and the other way round: this copy's error, asked of the other's classes
			const own = errorOf(kind);
			const OtherClass = foreign(kind).constructor;
			assert.notEqual(OtherClass, Class);
			assert.ok(own instanceof other.SqlError);
			assert.ok(own instanceof OtherClass);
		});
	}

	test("its fields and `retryable` read as this copy's do", () => {
		const error = foreign("deadlock");
		assert.equal(error.kind, "deadlock");
		assert.equal(error.dialect, "pg");
		assert.equal(error.code, "X");
		assert.equal(error.retryable, true);
		assert.equal(error.name, "DeadlockError");
		assert.equal(foreign("unique").retryable, false);
	});

	test("toSqlError passes the other copy's error through as it is", () => {
		const error = foreign("busy");
		const classify = (): never => assert.fail("classified again");
		assert.equal(toSqlError(error, "pg", classify), error);
		assert.equal(other.toSqlError(errorOf("busy"), "pg", classify).kind, "busy");
	});

	test("withRetry retries the other copy's retryable error by default, and no other", async () => {
		let calls = 0;
		const result = await withRetry(
			() => {
				calls++;
				if (calls === 1) throw foreign("serialization");
				return Promise.resolve("done");
			},
			{ initialDelayMs: 0 },
		);
		assert.equal(result, "done");
		assert.equal(calls, 2);

		const refused = foreign("unique");
		calls = 0;
		await assert.rejects(
			withRetry(
				() => {
					calls++;
					throw refused;
				},
				{ initialDelayMs: 0 },
			),
			(error) => error === refused,
		);
		assert.equal(calls, 1);
	});

	test("assert.rejects and a catch clause by class take the other copy's error", async () => {
		await assert.rejects(Promise.reject(foreign("unique")), UniqueViolationError);
		await assert.rejects(Promise.reject(foreign("unique")), SqlError);
	});

	test("an error of this copy stays what its prototype chain says", () => {
		// Built by hand as the base class: its kind does not make it the subclass.
		const base = new SqlError("x", "pg", { kind: "unique" });
		assert.ok(base instanceof SqlError);
		assert.equal(base instanceof UniqueViolationError, false);
		// A class declared outside the module: its own instances, and nobody else's.
		class AppConflict extends UniqueViolationError {}
		const app = new AppConflict("x", "pg", { kind: "unique" });
		assert.ok(app instanceof AppConflict);
		assert.ok(app instanceof UniqueViolationError);
		assert.ok(app instanceof SqlError);
		assert.equal(errorOf("unique") instanceof AppConflict, false);
		assert.equal(foreign("unique") instanceof AppConflict, false);
	});

	test("an error of a kind this copy does not know is a SqlError and nothing narrower", () => {
		// What a later version's new kind looks like from here: marked, kind unknown to us.
		const later = Object.assign(Object.create(other.SqlError.prototype) as object, {
			kind: "not_a_kind_yet",
		});
		assert.ok(later instanceof SqlError);
		for (const [, Class] of KINDS) {
			if (Class !== SqlError) assert.equal(later instanceof Class, false);
		}
	});

	test("what only looks like one is none: the mark is a symbol JSON cannot carry", () => {
		const shaped = {
			name: "SqlError",
			kind: "unique",
			dialect: "pg",
			retryable: true,
		};
		assert.equal(shaped instanceof SqlError, false);
		assert.equal(shaped instanceof UniqueViolationError, false);
		const parsed: unknown = JSON.parse(JSON.stringify(errorOf("unique")));
		assert.equal(parsed instanceof SqlError, false);
		for (const value of [null, undefined, 0, "SqlError", new Error("x"), {}, []]) {
			assert.equal(value instanceof SqlError, false);
			assert.equal(value instanceof DeadlockError, false);
		}
	});

	test("the mark is on the prototype, not enumerable, and no error carries it as its own", () => {
		const mark = Symbol.for("@marianmeres/sqlkit/error");
		const error = errorOf("unique");
		assert.equal((error as unknown as Record<symbol, unknown>)[mark], true);
		assert.equal(Object.hasOwn(error, mark), false);
		assert.deepEqual(Object.getOwnPropertySymbols(error), []);
		assert.equal(
			Object.getOwnPropertyDescriptor(SqlError.prototype, mark)?.enumerable,
			false,
		);
	});
});
