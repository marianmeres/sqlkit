// The Durable Object of the Durable Objects spike (plan doc 02 #1). One handler per
// assumption (A1–A6) and per probe (P1–P8); each observes and returns what it saw, and
// `test/do/probe.test.ts` asserts on it in Node. A handler that throws is reported as an
// error envelope, so an unexpected throw fails the test that called it, never the worker.
//
// Every call reaches a fresh object (an empty database) unless the test names one; only
// P8 does, to put two requests on one object.

import type { DurableObjectState, SqlStorage, SqlStorageValue } from "cloudflare:workers";
import { DurableObject } from "cloudflare:workers";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

type Handler = (ctx: DurableObjectState, payload: unknown) => unknown;

/** An error as plain JSON: everything it carries, not only its message. */
interface ErrorDescription {
	name: string;
	message: string;
	constructorName: string | undefined;
	isError: boolean;
	ownProperties: string[];
	fields: Record<string, unknown>;
	cause?: unknown;
	stack?: string;
}

function describeError(error: unknown): ErrorDescription {
	if (!(error instanceof Error)) {
		return {
			name: typeof error,
			message: String(error),
			constructorName: undefined,
			isError: false,
			ownProperties: [],
			fields: {},
		};
	}
	const fields: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(error)) {
		if (key === "stack" || key === "message") continue;
		fields[key] = jsonable((error as unknown as Record<string, unknown>)[key]);
	}
	return {
		name: error.name,
		message: error.message,
		constructorName: error.constructor?.name,
		isError: true,
		ownProperties: Object.getOwnPropertyNames(error).sort(),
		fields,
		...(error.cause === undefined ? {} : { cause: jsonable(error.cause) }),
		stack: error.stack,
	};
}

/** A value as JSON that keeps its JS type: `{ js, value }`. */
function describeValue(value: unknown): { js: string; value: unknown } {
	if (value === null) return { js: "null", value: null };
	if (value instanceof ArrayBuffer)
		return { js: "ArrayBuffer", value: [...new Uint8Array(value)] };
	if (ArrayBuffer.isView(value))
		return {
			js: value.constructor.name,
			value: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)],
		};
	if (typeof value === "bigint") return { js: "bigint", value: String(value) };
	return { js: typeof value, value };
}

function jsonable(value: unknown): unknown {
	if (value instanceof Error) return describeError(value);
	if (typeof value === "bigint") return String(value);
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
		return describeValue(value);
	return value;
}

/** Runs `fn` and reports whether it threw, and what. */
function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
	try {
		return { ok: true, value: fn() };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** P8: where each `hold` run is, by the key its test chose. Shared by the objects of one isolate. */
const holdState = new Map<string, string>();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function values(sql: SqlStorage, table = "t"): SqlStorageValue[] {
	return sql
		.exec<{ v: SqlStorageValue }>(`select v from ${table} order by rowid`)
		.toArray()
		.map((row) => row.v);
}

function changes(sql: SqlStorage): SqlStorageValue {
	return sql.exec<{ n: SqlStorageValue }>("select changes() as n").one().n;
}

const handlers: Record<string, Handler> = {
	// A1: sql.exec is synchronous, and a script with no bindings runs every statement.
	a1({ storage: { sql } }) {
		const cursor = sql.exec(
			"create table a (v); create table b (v); insert into a values (1); insert into b values (2), (3);",
		);
		return {
			returnsThenable:
				typeof (cursor as unknown as { then?: unknown }).then === "function",
			// read on the next line, with no await between: the script has already run
			a: values(sql, "a"),
			b: values(sql, "b"),
		};
	},

	// A2: transactionSync returns fn's value and undoes fn's writes when fn throws.
	a2({ storage }) {
		const { sql } = storage;
		sql.exec("create table t (v)");
		const returned = { answer: 42 };
		const value = storage.transactionSync(() => {
			sql.exec("insert into t values ('committed')");
			return returned;
		});
		const thrown = new Error("boom");
		let caught: unknown;
		try {
			storage.transactionSync(() => {
				sql.exec("insert into t values ('rolled back')");
				throw thrown;
			});
		} catch (error) {
			caught = error;
		}
		return {
			sameValue: value === returned,
			sameError: caught === thrown,
			rows: values(sql),
		};
	},

	// A3: the async transaction includes sql.exec writes, survives an await, rolls back on
	// rejection.
	async a3({ storage }) {
		const { sql } = storage;
		sql.exec("create table t (v)");
		const value = await storage.transaction(async () => {
			sql.exec("insert into t values ('before timer')");
			await sleep(20);
			sql.exec("insert into t values ('after timer')");
			await Promise.resolve();
			sql.exec("insert into t values ('after microtask')");
			return "resolved";
		});
		const committed = values(sql);

		const thrown = new Error("boom");
		let caught: unknown;
		let seenInside: SqlStorageValue[] = [];
		try {
			await storage.transaction(async () => {
				sql.exec("insert into t values ('undone before timer')");
				await sleep(20);
				sql.exec("insert into t values ('undone after timer')");
				seenInside = values(sql);
				throw thrown;
			});
		} catch (error) {
			caught = error;
		}
		return {
			value,
			committed,
			seenInside,
			afterRollback: values(sql),
			sameError: caught === thrown,
		};
	},

	// A4: transaction statements through sql.exec are refused.
	a4({ storage: { sql } }) {
		const statements = [
			"BEGIN",
			"BEGIN TRANSACTION",
			"BEGIN IMMEDIATE",
			"BEGIN EXCLUSIVE",
			"SAVEPOINT sp",
			"RELEASE sp",
			"ROLLBACK TO sp",
			"COMMIT",
			"END",
			"ROLLBACK",
		];
		const out: Record<string, { refused: boolean; error?: string }> = {};
		for (const statement of statements) {
			const result = attempt(() => sql.exec(statement));
			out[statement] = result.ok
				? { refused: false }
				: { refused: true, error: result.error };
		}
		return out;
	},

	// A5: AsyncLocalStorage under nodejs_compat keeps its store across awaits inside the
	// async transaction, both a store entered outside it and one entered inside the closure.
	async a5({ storage }) {
		const als = new AsyncLocalStorage<string>();
		return als.run("outer", async () => {
			const atStart = als.getStore();
			const inside = await storage.transaction(async () => {
				const before = als.getStore();
				await sleep(10);
				const afterTimer = als.getStore();
				storage.sql.exec("select 1");
				await Promise.resolve();
				const afterMicrotask = als.getStore();
				const nested = await als.run("inner", async () => {
					await sleep(10);
					const afterTimer = als.getStore();
					await Promise.resolve();
					return { afterTimer, afterMicrotask: als.getStore() };
				});
				return {
					before,
					afterTimer,
					afterMicrotask,
					nested,
					afterNested: als.getStore(),
				};
			});
			return { atStart, inside, afterTransaction: als.getStore() };
		});
	},

	// A6: node:assert/strict is importable and is the strict flavour.
	a6() {
		let failure: unknown;
		try {
			assert.deepEqual({ a: 1 }, { a: 2 });
		} catch (error) {
			failure = error;
		}
		const loose = attempt(() => assert.equal(1 as unknown, "1"));
		return {
			name: failure instanceof Error ? failure.name : undefined,
			code: (failure as { code?: unknown } | undefined)?.code,
			isAssertionError: failure instanceof assert.AssertionError,
			strictEqualityRefusesCoercion: !loose.ok,
		};
	},

	// P1: does transactionSync nest, and what does an inner throw undo?
	p1({ storage }) {
		const { sql } = storage;
		sql.exec("create table t (v)");
		const nested = attempt(() =>
			storage.transactionSync(() => {
				sql.exec("insert into t values ('outer 1')");
				const inner = storage.transactionSync(() => {
					sql.exec("insert into t values ('inner')");
					return "inner value";
				});
				sql.exec("insert into t values ('outer 2')");
				return inner;
			}),
		);
		const afterNested = values(sql);
		sql.exec("delete from t");

		let innerError: string | undefined;
		const innerThrows = attempt(() =>
			storage.transactionSync(() => {
				sql.exec("insert into t values ('outer 1')");
				try {
					storage.transactionSync(() => {
						sql.exec("insert into t values ('inner')");
						throw new Error("inner boom");
					});
				} catch (error) {
					innerError = (error as Error).message;
				}
				sql.exec("insert into t values ('outer 2')");
				return "outer value";
			}),
		);
		return {
			nested,
			afterNested,
			innerThrows,
			innerError,
			afterInnerThrows: values(sql),
		};
	},

	// P2: does the async transaction nest, and what does an inner rejection undo?
	async p2({ storage }) {
		const { sql } = storage;
		sql.exec("create table t (v)");
		const run = async <T>(fn: () => Promise<T>) => {
			try {
				return { ok: true as const, value: await fn() };
			} catch (error) {
				return { ok: false as const, error: (error as Error).message };
			}
		};
		const nested = await run(() =>
			storage.transaction(async () => {
				sql.exec("insert into t values ('outer 1')");
				const inner = await storage.transaction(async () => {
					sql.exec("insert into t values ('inner')");
					await sleep(5);
					return "inner value";
				});
				sql.exec("insert into t values ('outer 2')");
				return inner;
			}),
		);
		const afterNested = values(sql);
		sql.exec("delete from t");

		let innerError: string | undefined;
		const innerRejects = await run(() =>
			storage.transaction(async () => {
				sql.exec("insert into t values ('outer 1')");
				try {
					await storage.transaction(async () => {
						sql.exec("insert into t values ('inner')");
						await sleep(5);
						throw new Error("inner boom");
					});
				} catch (error) {
					innerError = (error as Error).message;
				}
				sql.exec("insert into t values ('outer 2')");
				return "outer value";
			}),
		);
		return {
			nested,
			afterNested,
			innerRejects,
			innerError,
			afterInnerRejects: values(sql),
		};
	},

	// P3: which JS values bind, and as what?
	p3({ storage: { sql } }) {
		const candidates: Record<string, unknown> = {
			null: null,
			string: "text",
			integer: 42,
			float: 1.5,
			unsafeInteger: 2 ** 53 + 2,
			arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
			booleanTrue: true,
			booleanFalse: false,
			date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
			bigint: 42n,
			bigintLarge: 2n ** 63n - 1n,
			uint8Array: new Uint8Array([1, 2, 3]),
			undefined: undefined,
			plainObject: { a: 1 },
			array: [1, 2],
		};
		const out: Record<string, unknown> = {};
		for (const [label, value] of Object.entries(candidates)) {
			const result = attempt(() =>
				sql
					.exec<{ v: SqlStorageValue; t: SqlStorageValue }>(
						"select ? as v, typeof(?) as t",
						value,
						value,
					)
					.one(),
			);
			out[label] = result.ok
				? {
						binds: true,
						sqliteType: result.value.t,
						returned: describeValue(result.value.v),
					}
				: { binds: false, error: result.error };
		}
		// a whole JS number binds as `real` above: what an integer column and LIMIT make of it
		sql.exec("create table typed (n integer)");
		sql.exec("insert into typed values (?)", 42);
		out.integerIntoIntegerColumn = sql
			.exec<{ t: SqlStorageValue }>("select typeof(n) as t from typed")
			.one().t;
		const limit = attempt(() =>
			sql.exec("select 1 as v union all select 2 limit ?", 1).toArray(),
		);
		out.integerAsLimit = limit.ok
			? { binds: true, rows: limit.value.length }
			: { binds: false, error: limit.error };
		return out;
	},

	// P4: the affected-row count of a write: the cursor's rowsWritten, or changes()?
	p4({ storage: { sql } }) {
		sql.exec("create table plain (id integer primary key, v integer)");
		sql.exec("create table indexed (id integer primary key, v integer)");
		sql.exec("create index indexed_v on indexed (v)");
		const measure = (write: string) => {
			const cursor = sql.exec(write);
			const rowsWrittenBeforeRead = cursor.rowsWritten;
			const rows = cursor.toArray().length;
			return {
				rowsWrittenBeforeRead,
				rowsWrittenAfterRead: cursor.rowsWritten,
				changes: changes(sql),
				rows,
			};
		};
		const out: Record<string, Record<string, unknown>> = {};
		for (const table of ["plain", "indexed"]) {
			out[table] = {
				insert3: measure(`insert into ${table} (v) values (1), (2), (3)`),
				update2: measure(`update ${table} set v = v + 10 where v >= 2`),
				update0: measure(`update ${table} set v = 0 where v > 1000`),
				updateReturning3: measure(`update ${table} set v = v + 1 returning id`),
				delete1: measure(`delete from ${table} where id = 1`),
				select: measure(`select * from ${table}`),
				ddl: measure(`create table ${table}_ddl (x)`),
			};
		}
		return out;
	},

	// P5: what the error of each constraint violation carries.
	p5({ storage: { sql } }) {
		sql.exec(`
			create table parent (id integer primary key);
			create table child (
				id integer primary key,
				parent_id integer references parent (id),
				name text not null,
				qty integer constraint qty_positive check (qty > 0),
				code text constraint child_code_unique unique
			);
			insert into parent values (1);
			insert into child (id, parent_id, name, qty, code) values (1, 1, 'a', 1, 'x');
		`);
		const violate = (statement: string) => {
			try {
				sql.exec(statement);
				return { threw: false };
			} catch (error) {
				return { threw: true, error: describeError(error) };
			}
		};
		return {
			unique: violate("insert into child (name, qty, code) values ('b', 1, 'x')"),
			foreignKey: violate(
				"insert into child (parent_id, name, qty) values (99, 'b', 1)",
			),
			notNull: violate("insert into child (qty) values (1)"),
			check: violate("insert into child (name, qty) values ('b', 0)"),
			syntax: violate("selec 1"),
		};
	},

	// P6: are PRAGMA query_only and PRAGMA foreign_keys permitted; are foreign keys on?
	p6({ storage: { sql } }) {
		sql.exec(`
			create table parent (id integer primary key);
			create table child (id integer primary key, parent_id integer references parent (id));
		`);
		const pragma = (statement: string) => {
			const result = attempt(() => sql.exec(statement).toArray());
			return result.ok
				? { permitted: true, rows: result.value }
				: { permitted: false, error: result.error };
		};
		const orphan = (id: number) => {
			const result = attempt(() =>
				sql.exec("insert into child (id, parent_id) values (?, 99)", id),
			);
			return result.ok
				? { refused: false }
				: { refused: true, error: result.error };
		};
		const foreignKeysDefault = pragma("PRAGMA foreign_keys");
		const orphanByDefault = orphan(1);
		const foreignKeysOff = pragma("PRAGMA foreign_keys = OFF");
		const foreignKeysAfterOff = pragma("PRAGMA foreign_keys");
		const orphanAfterOff = orphan(2);
		const foreignKeysOn = pragma("PRAGMA foreign_keys = ON");
		const deferForeignKeys = pragma("PRAGMA defer_foreign_keys = ON");

		const queryOnlyDefault = pragma("PRAGMA query_only");
		const queryOnlyOn = pragma("PRAGMA query_only = ON");
		const queryOnlyAfterOn = pragma("PRAGMA query_only");
		const writeWhileQueryOnly = attempt(() =>
			sql.exec("insert into parent values (2)"),
		);
		const queryOnlyOff = pragma("PRAGMA query_only = OFF");
		const writeAfterQueryOnlyOff = attempt(() =>
			sql.exec("insert into parent values (3)"),
		);
		return {
			foreignKeysDefault,
			orphanByDefault,
			foreignKeysOff,
			foreignKeysAfterOff,
			orphanAfterOff,
			foreignKeysOn,
			deferForeignKeys,
			queryOnlyDefault,
			queryOnlyOn,
			queryOnlyAfterOn,
			writeWhileQueryOnly: writeWhileQueryOnly.ok
				? { refused: false }
				: { refused: true, error: writeWhileQueryOnly.error },
			queryOnlyOff,
			writeAfterQueryOnlyOff: writeAfterQueryOnlyOff.ok
				? { refused: false }
				: { refused: true, error: writeAfterQueryOnlyOff.error },
			parents: sql.exec("select id from parent order by id").toArray(),
		};
	},

	// P7: sqlite_version(), RETURNING, ON CONFLICT. Where sqlite_version() is refused, the
	// version is bounded by features that arrived in a known release.
	p7({ storage: { sql } }) {
		sql.exec("create table t (id integer primary key, k text unique, v integer)");
		const scalar = (expression: string) => {
			const result = attempt(
				() =>
					sql.exec<{ v: SqlStorageValue }>(`select ${expression} as v`).one().v,
			);
			return result.ok
				? { works: true, value: result.value }
				: { works: false, error: result.error };
		};
		return {
			version: scalar("sqlite_version()"),
			sinceRelease: {
				"3.38.0 ->>": scalar(`'{"a":1}' ->> '$.a'`),
				"3.38.0 unixepoch()": scalar("unixepoch('2026-01-01')"),
				"3.44.0 concat()": scalar("concat('a', 'b')"),
				"3.45.0 jsonb()": scalar("typeof(jsonb('{}'))"),
				"3.46.0 json_pretty()": scalar("json_pretty('[]')"),
				"3.50.0 unistr()": scalar("unistr('\\0041')"),
			},
			returning: attempt(() =>
				sql
					.exec("insert into t (k, v) values ('a', 1) returning id, k, v")
					.toArray(),
			),
			onConflictDoNothing: attempt(() =>
				sql
					.exec(
						"insert into t (k, v) values ('a', 2) on conflict (k) do nothing returning id",
					)
					.toArray(),
			),
			onConflictDoUpdate: attempt(() =>
				sql
					.exec(
						"insert into t (k, v) values ('a', 3) on conflict (k) do update set v = excluded.v returning k, v",
					)
					.toArray(),
			),
			rows: sql.exec("select k, v from t").toArray(),
		};
	},

	// P8: while an async transaction awaits a timer, does a second request's statement run,
	// and is it inside that transaction? Handlers on one object: setup, then `hold` and
	// `peek` sent concurrently, then `read`. `hold` with `transaction: false` is the
	// control: the same timer outside any transaction. `peek` reports where `hold` was when
	// it ran, so a run where it arrived too early is seen as such, not misread.
	"p8-setup"({ storage: { sql } }) {
		sql.exec("create table t (v)");
		return null;
	},
	async "p8-hold"({ storage }, payload) {
		const { ms, key, transaction } = payload as {
			ms: number;
			key: string;
			transaction: boolean;
		};
		const { sql } = storage;
		let seenAfterTimer: SqlStorageValue[] = [];
		holdState.set(key, "started");
		try {
			if (transaction) {
				await storage.transaction(async () => {
					sql.exec("insert into t values ('hold')");
					holdState.set(key, "awaiting timer");
					await sleep(ms);
					seenAfterTimer = values(sql);
					throw new Error("roll back on purpose");
				});
			} else {
				sql.exec("insert into t values ('hold')");
				holdState.set(key, "awaiting timer");
				await sleep(ms);
				seenAfterTimer = values(sql);
			}
		} catch {
			// the rollback is the point
		} finally {
			holdState.set(key, "finished");
		}
		return { seenAfterTimer };
	},
	"p8-peek"({ storage: { sql } }, payload) {
		const { key } = payload as { key: string };
		const hold = holdState.get(key) ?? "not started";
		const seen = values(sql);
		sql.exec("insert into t values ('peek')");
		return { hold, seen };
	},
	"p8-read"({ storage: { sql } }) {
		return { rows: values(sql) };
	},

	// P9 (added at T19): when does workerd check a deferred foreign key? Handlers on one
	// object: setup, one of the `p9-violate` modes, then `p9-read`. A violation inside
	// `transactionSync` or `transaction` that the closure leaves unfixed is not refused
	// when the closure ends: the handler returns, and only then does the request fail. A
	// mode that throws inside the handler would answer a JSON envelope instead, so the
	// test tells the two apart by the answer's shape. `p9-fix` repairs the reference later
	// in the same request, outside the transaction.
	"p9-setup"({ storage: { sql } }) {
		sql.exec(
			"create table parent (id integer primary key);" +
				"create table child (id integer primary key, p integer references parent (id) deferrable initially deferred);" +
				"insert into parent values (1)",
		);
		return null;
	},
	async "p9-violate"({ storage }, payload) {
		const { mode } = payload as { mode: "sync" | "async" | "bare" };
		const orphan = () => storage.sql.exec("insert into child values (1, 99)");
		if (mode === "sync") storage.transactionSync(orphan);
		else if (mode === "async") await storage.transaction(async () => orphan());
		else orphan();
		return { returned: mode };
	},
	"p9-fix"({ storage }) {
		storage.transactionSync(
			() => storage.sql.exec("insert into child values (2, 7)").rowsWritten,
		);
		storage.sql.exec("insert into parent values (7)");
		return { returned: "fix" };
	},
	"p9-read"({ storage: { sql } }) {
		return sql
			.exec<{ children: SqlStorageValue; parents: SqlStorageValue }>(
				"select (select count(*) from child) as children, (select count(*) from parent) as parents",
			)
			.one();
	},
};

export class TestObject extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
		const handler = handlers[name];
		if (!handler) {
			return Response.json({
				ok: false,
				error: { name: "TypeError", message: `no handler named "${name}"` },
			});
		}
		try {
			const payload: unknown = await request.json();
			const value = await handler(this.ctx, payload);
			return Response.json({ ok: true, value });
		} catch (error) {
			const { name, message, stack } = describeError(error);
			return Response.json({ ok: false, error: { name, message, stack } });
		}
	}
}
