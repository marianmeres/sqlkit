// The contract's helpers (plan doc 01 #2): readOnlyOf and assertLockName as ported from the
// prior implementation (tmp/prior-art/engine/driver/contract.ts), and statementOf, which
// every adapter calls first, including its refusal of params beside a fragment. The last
// group but one proves the two interfaces can be implemented as written: one function per
// overloaded `query`, a `tx` that is the driver itself. The last is `isDriver`, which
// reads the contract member by member, on plain objects. No database.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { missingFromDriver } from "../../src/core/contract.ts";
import {
	assertLockName,
	type Capabilities,
	type Driver,
	isDriver,
	type QueryResult,
	type Row,
	readOnlyOf,
	type Sql,
	type SyncDriver,
	sql,
	statementOf,
} from "../../src/mod.ts";

function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

describe("unit/contract: readOnlyOf", () => {
	test("absent is false", () => {
		assert.equal(readOnlyOf(undefined), false);
		assert.equal(readOnlyOf({}), false);
		assert.equal(readOnlyOf({ readOnly: undefined }), false);
	});

	test("a boolean is itself", () => {
		assert.equal(readOnlyOf({ readOnly: true }), true);
		assert.equal(readOnlyOf({ readOnly: false }), false);
	});

	test("anything else is a TypeError, truthy or not", () => {
		for (const value of ["yes", "", 1, 0, null, {}, []]) {
			assert.throws(
				() => readOnlyOf({ readOnly: value as unknown as boolean }),
				typeError(/readOnly.*takes a boolean/),
				JSON.stringify(value),
			);
		}
	});
});

describe("unit/contract: assertLockName", () => {
	test("a non-empty string passes", () => {
		assert.doesNotThrow(() => assertLockName("migrate"));
		assert.doesNotThrow(() => assertLockName(" "));
	});

	test("an empty or missing name, or not a string, is a TypeError", () => {
		for (const value of ["", undefined, null, 1, {}, Symbol("lock")]) {
			assert.throws(
				() => assertLockName(value),
				typeError(/non-empty lock name/),
				String(value),
			);
		}
	});

	test("it narrows: after it, the name is a string", () => {
		const name: unknown = "jobs";
		assertLockName(name);
		assert.equal(name.length, 4);
	});
});

describe("unit/contract: statementOf", () => {
	test("a fragment is rendered in the dialect's placeholder style", () => {
		const statement = sql`select * from t where a = ${1} and b = ${"x"}`;
		assert.deepEqual(statementOf(statement, undefined, "pg"), {
			text: "select * from t where a = $1 and b = $2",
			params: [1, "x"],
		});
		assert.deepEqual(statementOf(statement, undefined, "sqlite"), {
			text: "select * from t where a = ? and b = ?",
			params: [1, "x"],
		});
	});

	test("text and params pass through as they are, params as a copy", () => {
		const params = [1, "x", { a: 1 }];
		const out = statementOf("select $1, $2, $3", params, "pg");
		assert.equal(out.text, "select $1, $2, $3");
		assert.deepEqual(out.params, params);
		assert.notEqual(out.params, params);
		// Passed through: the parameter rule is applied after, not here.
		assert.deepEqual(statementOf("select ?", [true], "sqlite").params, [true]);
	});

	test("text without params has none", () => {
		assert.deepEqual(statementOf("select 1", undefined, "sqlite"), {
			text: "select 1",
			params: [],
		});
	});

	test("params beside a fragment are refused, even an empty list", () => {
		for (const params of [[1], []]) {
			assert.throws(
				() => statementOf(sql`select ${1}`, params, "pg"),
				typeError(/takes no params/),
				JSON.stringify(params),
			);
		}
	});

	test("a statement that is neither a fragment nor text is a TypeError", () => {
		// A look-alike is not a fragment (D25): it is refused, never spliced as SQL.
		const lookAlike = { kind: "sql", chunks: ["drop table t"], values: [] };
		for (const value of [lookAlike, 1, null, undefined, ["select 1"]]) {
			assert.throws(
				() => statementOf(value as unknown as Sql, undefined, "pg"),
				typeError(/fragment built by sql`` or SQL text/),
				JSON.stringify(value),
			);
		}
	});

	test("params that are not an array are a TypeError", () => {
		for (const value of ["abc", { 0: 1, length: 1 }, null]) {
			assert.throws(
				() => statementOf("select $1", value as unknown as unknown[], "pg"),
				typeError(/takes an array/),
				JSON.stringify(value),
			);
		}
	});

	test("an unknown dialect is a TypeError, for text and for a fragment", () => {
		for (const statement of ["select 1", sql`select 1`]) {
			assert.throws(
				() => statementOf(statement, undefined, "mysql" as "pg"),
				typeError(/unknown dialect "mysql"/),
			);
		}
	});
});

describe("unit/contract: the interfaces can be implemented as written", () => {
	const capabilities: Capabilities = {
		sync: true,
		concurrentWriters: false,
		crossProcessLock: false,
	};

	/** A fake that records what it was asked, answering one row per statement. */
	function fakeDriver(): {
		driver: Driver;
		seen: { text: string; params: unknown[] }[];
	} {
		const seen: { text: string; params: unknown[] }[] = [];
		function run<T>(
			statement: Sql | string,
			params?: readonly unknown[],
		): QueryResult<T> {
			const rendered = statementOf(statement, params, "sqlite");
			seen.push(rendered);
			return { rows: [{ n: 1 } as T], rowCount: 1 };
		}
		const sync: SyncDriver = {
			dialect: "sqlite",
			adapter: "fake",
			capabilities,
			query: run,
			exec: () => {},
			transaction: (fn) => fn(sync),
			savepoint: (fn) => fn(sync),
		};
		const driver: Driver = {
			dialect: "sqlite",
			adapter: "fake",
			capabilities,
			query: async <T = Row>(
				statement: Sql | string,
				params?: readonly unknown[],
			) => run<T>(statement, params),
			exec: async () => {},
			transaction: (fn) => fn(driver),
			savepoint: (fn) => fn(driver),
			exclusive: (_name, fn) => fn(driver),
			close: async () => {},
			sync,
		};
		return { driver, seen };
	}

	test("both forms of query reach one implementation; tx is the driver", async () => {
		const { driver, seen } = fakeDriver();
		const a = await driver.query<{ n: number }>(sql`select ${1} as n`);
		const b = await driver.query<{ n: number }>("select ? as n", [1]);
		assert.equal(a.rows[0]?.n, 1);
		assert.equal(b.rowCount, 1);
		await driver.transaction(async (tx) => {
			assert.equal(tx, driver);
		});
		const viaSync = driver.sync?.transaction((tx) => tx.query("select 1").rowCount);
		assert.equal(viaSync, 1);
		assert.deepEqual(seen, [
			{ text: "select ? as n", params: [1] },
			{ text: "select ? as n", params: [1] },
			{ text: "select 1", params: [] },
		]);
	});
});

describe("unit/contract: isDriver", () => {
	const nothing = (): void => {};

	/** A driver as plain as the contract allows, without a sync tier. */
	function plain(): Record<string, unknown> {
		return {
			dialect: "pg",
			adapter: "plain",
			capabilities: {
				sync: false,
				concurrentWriters: true,
				crossProcessLock: true,
			},
			query: nothing,
			exec: nothing,
			transaction: nothing,
			exclusive: nothing,
			savepoint: nothing,
			close: nothing,
		};
	}

	/** A sync tier as plain as the contract allows. */
	function plainSync(): Record<string, unknown> {
		return {
			dialect: "sqlite",
			adapter: "plain",
			capabilities: {
				sync: true,
				concurrentWriters: false,
				crossProcessLock: false,
			},
			query: nothing,
			exec: nothing,
			transaction: nothing,
			savepoint: nothing,
		};
	}

	test("a driver is one, with a sync tier or without", () => {
		assert.equal(isDriver(plain()), true);
		assert.equal(isDriver({ ...plain(), sync: plainSync() }), true);
		assert.equal(isDriver({ ...plain(), dialect: "sqlite" }), true);
		assert.deepEqual(missingFromDriver(plain()), []);
	});

	test("it narrows: after it, the value is a Driver", () => {
		const value: unknown = plain();
		assert.ok(isDriver(value));
		const driver: Driver = value;
		assert.equal(driver.adapter, "plain");
	});

	test("every member counts: without any one, or with one of another type, it is not a driver", () => {
		for (const member of Object.keys(plain())) {
			const without = plain();
			delete without[member];
			assert.equal(isDriver(without), false, `without ${member}`);
			for (const wrong of [null, 1, true, {}]) {
				// An object is what `capabilities` is, and it states nothing: still not one.
				const other = { ...plain(), [member]: wrong };
				assert.equal(
					isDriver(other),
					false,
					`${member}: ${JSON.stringify(wrong)}`,
				);
			}
		}
		// A string is what `dialect` is, and only two of them are one.
		assert.equal(isDriver({ ...plain(), dialect: "mysql" }), false);
	});

	test("capabilities state every fact, as a boolean", () => {
		for (const fact of ["sync", "concurrentWriters", "crossProcessLock"]) {
			const capabilities: Record<string, unknown> = {
				sync: false,
				concurrentWriters: true,
				crossProcessLock: true,
			};
			delete capabilities[fact];
			assert.equal(isDriver({ ...plain(), capabilities }), false, fact);
			assert.equal(
				isDriver({ ...plain(), capabilities: { ...capabilities, [fact]: 1 } }),
				false,
				`${fact}: 1`,
			);
		}
	});

	test("a sync tier that is there has to be one", () => {
		for (const method of ["query", "exec", "transaction", "savepoint"]) {
			const sync = plainSync();
			delete sync[method];
			assert.equal(isDriver({ ...plain(), sync }), false, `sync without ${method}`);
		}
		for (const sync of [null, true, "sync", nothing]) {
			assert.equal(isDriver({ ...plain(), sync }), false, String(sync));
		}
	});

	test("a sync tier is not a driver, and neither is what is no object", () => {
		assert.equal(isDriver(plainSync()), false);
		for (const value of [undefined, null, "", "driver", 0, 1, true, nothing, []]) {
			assert.equal(isDriver(value), false, String(value));
		}
		assert.equal(missingFromDriver(undefined), undefined);
		assert.equal(missingFromDriver("driver"), undefined);
	});

	test("what is missing is named, as a refusal would name it", () => {
		const old = plain();
		delete old.savepoint;
		assert.deepEqual(missingFromDriver(old), ["savepoint()"]);
		assert.deepEqual(missingFromDriver(plainSync()), ["exclusive()", "close()"]);
		assert.deepEqual(
			missingFromDriver({
				dialect: "mysql",
				capabilities: { sync: true },
				sync: {},
			}),
			[
				'dialect of "pg" or "sqlite"',
				"adapter name",
				"capabilities.concurrentWriters",
				"capabilities.crossProcessLock",
				"query()",
				"exec()",
				"transaction()",
				"exclusive()",
				"savepoint()",
				"close()",
				"sync.query()",
				"sync.exec()",
				"sync.transaction()",
				"sync.savepoint()",
			],
		);
	});
});
