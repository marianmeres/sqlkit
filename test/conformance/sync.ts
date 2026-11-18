// The `sync` conformance body: the sync tier (`driver.sync`) and the rules S1–S6 of what the
// two tiers refuse of each other (plan doc 02 #3, D03, D16), on every registered adapter
// that has one. An adapter the registry marks as having none is held to that instead.
//
// Runner-agnostic: no `node:test` here, so the same cases run inside workerd. Every case
// creates and disposes a database of its own. A refusal on the sync tier is a `TypeError`
// thrown at the call; one on the async tier is a promise that rejects with it (R1).

import assert from "node:assert/strict";
import { type Driver, type QueryResult, type SyncDriver, sql } from "../../src/mod.ts";
import type { AdapterCase, Suite } from "./_suite.ts";

/** A promise and the function that resolves it: a gate a case opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** A real timer, not a resolved promise: what a transaction waiting on I/O looks like. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The promise `call` answered with; a synchronous throw fails the case. */
function promiseOf(what: string, call: () => unknown): Promise<unknown> {
	let answered: unknown;
	try {
		answered = call();
	} catch (error) {
		return assert.fail(`${what} threw at the call: ${String(error)}`);
	}
	assert.ok(answered instanceof Promise, `${what} answered no promise`);
	return answered;
}

/** An error that is a `TypeError`, whose message matches `pattern` when one is given. */
function typeError(pattern?: RegExp): (error: unknown) => boolean {
	return (error) =>
		error instanceof TypeError &&
		(pattern === undefined || pattern.test(error.message));
}

const READ_ONLY = /read-?only/i;

/** `insert into t` one row, synchronously. */
function insert(tx: SyncDriver, id: string, name = id): QueryResult {
	return tx.query(sql`insert into t (id, name) values (${id}, ${name})`);
}

/** Rows of `t`, or rows of `t` with `id`, synchronously. */
function count(tx: SyncDriver, id?: string): number {
	const { rows } = tx.query<{ c: number | string }>(
		id === undefined
			? sql`select count(*) as c from t`
			: sql`select count(*) as c from t where id = ${id}`,
	);
	return Number(rows[0]?.c ?? -1);
}

/** `insert into t` one row, through the async tier. */
function insertAsync(db: Driver, id: string, name = id): Promise<unknown> {
	return db.query(sql`insert into t (id, name) values (${id}, ${name})`);
}

/** Rows of `t` with `id`, through the async tier. */
async function countAsync(db: Driver, id: string): Promise<number> {
	const { rows } = await db.query<{ c: number | string }>(
		sql`select count(*) as c from t where id = ${id}`,
	);
	return Number(rows[0]?.c ?? -1);
}

export function syncContract(suite: Suite, adapter: AdapterCase): void {
	if (!adapter.sync) {
		suite.test(
			"has no sync tier: capabilities.sync is false, sync is undefined",
			async () => {
				const fixture = await adapter.create();
				try {
					assert.equal(fixture.driver.capabilities.sync, false);
					assert.equal(fixture.driver.sync, undefined);
				} finally {
					await fixture.dispose();
				}
			},
		);
		return;
	}

	/** One case, on a database of its own holding an empty table `t`. */
	const test = (
		name: string,
		body: (tier: SyncDriver, db: Driver) => void | Promise<void>,
	): void => {
		suite.test(name, async () => {
			const fixture = await adapter.create();
			try {
				const db = fixture.driver;
				await db.query(
					"create table t (id text primary key, name text not null)",
				);
				assert.ok(
					db.sync !== undefined,
					`${adapter.name}: driver.sync is undefined`,
				);
				await body(db.sync, db);
			} finally {
				await fixture.dispose();
			}
		});
	};

	// ── The tier ────────────────────────────────────────────────────────────────────

	test("the sync tier is there, and is the same connection as the async one", async (tier, db) => {
		assert.equal(db.capabilities.sync, true);
		assert.equal(tier.dialect, db.dialect);
		assert.equal(tier.adapter, db.adapter);
		assert.deepEqual(tier.capabilities, db.capabilities);
		insert(tier, "written-sync");
		assert.equal(await countAsync(db, "written-sync"), 1);
		await insertAsync(db, "written-async");
		assert.equal(count(tier, "written-async"), 1);
	});

	// ── The list: commit, rollback, rowCount, exec, read-only, parameters ───────────

	test("commit: a sync transaction commits when its callback returns, and answers its value", async (tier, db) => {
		const answer = tier.transaction((tx) => {
			assert.equal(tx, tier, "the callback was handed another handle");
			insert(tx, "committed");
			return "answer";
		});
		assert.equal(answer, "answer");
		assert.equal(count(tier, "committed"), 1);
		assert.equal(await countAsync(db, "committed"), 1);
	});

	test("rollback: a sync transaction rolls back when its callback throws, with that error", (tier) => {
		const boom = new Error("boom");
		assert.throws(
			() =>
				tier.transaction((tx) => {
					insert(tx, "rolled-back");
					assert.equal(
						count(tx, "rolled-back"),
						1,
						"the write is visible inside its own transaction",
					);
					throw boom;
				}),
			(error) => error === boom,
		);
		assert.equal(count(tier, "rolled-back"), 0);
		// Nothing was left open: the next transaction is one of its own.
		tier.transaction((tx) => insert(tx, "after"));
		assert.equal(count(tier, "after"), 1);
	});

	test("rowCount: the rows a statement returns, or the rows it affected", (tier) => {
		assert.deepEqual(
			tier.query(
				"insert into t (id, name) values ('a', 'a'), ('b', 'b'), ('c', 'c')",
			),
			{ rows: [], rowCount: 3 },
		);
		assert.deepEqual(tier.query("select id from t order by id"), {
			rows: [{ id: "a" }, { id: "b" }, { id: "c" }],
			rowCount: 3,
		});
		assert.deepEqual(tier.query("select id from t where id = 'z'"), {
			rows: [],
			rowCount: 0,
		});
		assert.deepEqual(tier.query("update t set name = 'x' where id in ('a', 'b')"), {
			rows: [],
			rowCount: 2,
		});
		assert.deepEqual(tier.query("delete from t where id = 'z'"), {
			rows: [],
			rowCount: 0,
		});
		assert.deepEqual(
			tier.query("update t set name = 'y' where id = 'a' returning id, name"),
			{ rows: [{ id: "a", name: "y" }], rowCount: 1 },
		);
		assert.deepEqual(tier.query("delete from t where id = 'c' returning id"), {
			rows: [{ id: "c" }],
			rowCount: 1,
		});
		assert.deepEqual(tier.query("delete from t where id = 'b'"), {
			rows: [],
			rowCount: 1,
		});
	});

	test("exec: runs every statement of a script, and joins the open sync transaction", (tier) => {
		assert.equal(
			tier.exec(
				[
					"insert into t (id, name) values ('script-1', 'a');",
					"create table u (id text primary key);",
					"insert into t (id, name) values ('script-2', 'b'), ('script-3', 'c');",
					"insert into u (id) values ('u-1');",
				].join("\n"),
			),
			undefined,
		);
		assert.equal(count(tier), 3);
		assert.deepEqual(tier.query("select id from u").rows, [{ id: "u-1" }]);

		const failed = new Error("rolled back");
		assert.throws(
			() =>
				tier.transaction((tx) => {
					tx.exec("insert into t (id, name) values ('exec-in-tx', 'x')");
					assert.equal(count(tx, "exec-in-tx"), 1);
					throw failed;
				}),
			(error) => error === failed,
		);
		assert.equal(count(tier, "exec-in-tx"), 0);
	});

	test("read-only: a read-only sync transaction reads, refuses a write, and the connection writes again after it", (tier) => {
		insert(tier, "before");
		assert.equal(
			tier.transaction((tx) => count(tx), { readOnly: true }),
			1,
		);
		assert.throws(
			() =>
				tier.transaction((tx) => insert(tx, "read-only-write"), {
					readOnly: true,
				}),
			READ_ONLY,
		);
		assert.throws(
			() =>
				tier.transaction(
					(tx) =>
						tx.exec(
							"insert into t (id, name) values ('read-only-exec', 'x')",
						),
					{ readOnly: true },
				),
			READ_ONLY,
		);
		assert.equal(count(tier), 1);
		insert(tier, "after");
		assert.equal(count(tier, "after"), 1);
		// Anything but a boolean is refused at the call, before anything is opened.
		let ran = false;
		assert.throws(
			() =>
				tier.transaction(
					() => {
						ran = true;
					},
					{ readOnly: "yes" as unknown as boolean },
				),
			typeError(/readOnly/),
		);
		assert.equal(ran, false);
	});

	test("parameters: values bind by the parameter rule; a refused call throws a TypeError", (tier, db) => {
		const { rows } = tier.query<Record<string, unknown>>(
			sql`select
				case when cast(${null} as text) is null then 1 else 0 end as is_null,
				case when cast(${undefined} as text) is null then 1 else 0 end as undefined_is_null,
				case when ${true} then 1 else 0 end as yes,
				case when ${false} then 1 else 0 end as no,
				cast(${42} as integer) as n,
				cast(${"text"} as text) as s,
				cast(${{ a: 1, b: [true, null] }} as text) as object_json`,
		);
		assert.deepEqual(rows, [
			{
				is_null: 1,
				undefined_is_null: 1,
				yes: 1,
				no: 0,
				n: 42,
				s: "text",
				object_json: '{"a":1,"b":[true,null]}',
			},
		]);
		for (const row of rows)
			assert.equal(Object.getPrototypeOf(row), Object.prototype);

		// Text with its parameters, in the dialect's placeholder style.
		const text = db.dialect === "sqlite" ? "select ? as n" : "select $1::int as n";
		assert.deepEqual(tier.query(text, [7]).rows, [{ n: 7 }]);

		if (db.dialect === "sqlite") {
			const date = new Date("2026-01-02T03:04:05.000Z");
			const { rows: cells } = tier.query<Record<string, unknown>>(
				sql`select ${date} as d, typeof(${date}) as d_type`,
			);
			assert.deepEqual(cells, [{ d: "2026-01-02T03:04:05.000Z", d_type: "text" }]);
			assert.throws(
				() => tier.query(sql`select ${[1, 2]} as a`),
				typeError(/json\(\)|inList/),
			);
		}

		// What no database can bind, and calls that are mistakes, throw at the call.
		assert.throws(() => tier.query(sql`select ${() => 1} as f`), typeError());
		assert.throws(() => tier.query(sql`select ${new Map()} as m`), typeError());
		const loose = tier.query as (statement: unknown, params?: unknown) => unknown;
		assert.throws(
			() => loose.call(tier, sql`select ${1} as n`, [1]),
			typeError(/takes no params/),
		);
		assert.throws(() => tier.query(42 as unknown as string), typeError());
		assert.throws(() => tier.exec(undefined as unknown as string), typeError());
		assert.throws(() => tier.transaction(null as never), typeError());
		// Nothing was left open by a refusal.
		tier.transaction((tx) => insert(tx, "after-refusals"));
		assert.equal(count(tier), 1);
	});

	// ── S1–S6 ───────────────────────────────────────────────────────────────────────

	test("S1: a sync transaction whose callback returns a thenable rolls back, with a TypeError", (tier) => {
		// An async callback: everything before its first await ran inside, and is undone.
		assert.throws(
			() =>
				tier.transaction(async (tx) => {
					insert(tx, "async-callback");
				}),
			typeError(/promise/),
		);
		assert.equal(count(tier, "async-callback"), 0);
		// One that rejects: the answer is still the TypeError, and the rejection is not
		// left unhandled.
		assert.throws(
			() =>
				tier.transaction(async (tx) => {
					insert(tx, "async-rejected");
					throw new Error("inside");
				}),
			typeError(/promise/),
		);
		assert.equal(count(tier, "async-rejected"), 0);
		// A thenable that is not a promise.
		assert.throws(
			() =>
				tier.transaction((tx) => {
					insert(tx, "thenable");
					// biome-ignore lint/suspicious/noThenProperty: a thenable that is not a promise is what S1 refuses
					return { then: (): void => undefined };
				}),
			typeError(),
		);
		assert.equal(count(tier, "thenable"), 0);
		// Nested: the TypeError reaches the open transaction, which rolls back with it.
		assert.throws(
			() =>
				tier.transaction((tx) => {
					insert(tx, "outer");
					tx.transaction(async () => undefined);
				}),
			typeError(/promise/),
		);
		assert.equal(count(tier, "outer"), 0);
		// The connection is in no transaction afterwards.
		tier.transaction((tx) => insert(tx, "after"));
		assert.equal(count(tier), 1);
	});

	test("S2: a nested sync transaction joins the open one, as it was opened", (tier) => {
		const failed = new Error("outer failed");
		assert.throws(
			() =>
				tier.transaction((tx) => {
					insert(tx, "outer");
					const inner = tx.transaction((nested) => {
						assert.equal(
							nested,
							tier,
							"the nested callback was handed another handle",
						);
						insert(nested, "inner");
						return "inner value";
					});
					assert.equal(inner, "inner value");
					assert.equal(count(tx, "inner"), 1);
					throw failed;
				}),
			(error) => error === failed,
		);
		assert.equal(count(tier, "outer"), 0, "the nested block committed on its own");
		assert.equal(count(tier, "inner"), 0, "the nested block committed on its own");

		// Read-only nested in a write transaction: it is that transaction, and writes.
		tier.transaction((tx) => {
			insert(tx, "write-outer");
			tx.transaction((inner) => insert(inner, "written-inside"), {
				readOnly: true,
			});
		});
		assert.equal(count(tier, "written-inside"), 1);
		// A write nested in a read-only transaction is refused with it.
		assert.throws(
			() =>
				tier.transaction(
					(tx) => tx.transaction((inner) => insert(inner, "nested-write")),
					{
						readOnly: true,
					},
				),
			READ_ONLY,
		);
		assert.equal(count(tier, "nested-write"), 0);
	});

	test("S3: a sync call from inside an open async transaction's own context runs inside it", async (tier, db) => {
		const failed = new Error("the async transaction failed");
		await assert.rejects(
			db.transaction(async (tx) => {
				await insertAsync(tx, "async-row");
				// Across a real timer: the context is still the transaction's.
				await sleep(5);
				insert(tier, "sync-row");
				assert.equal(
					count(tier, "async-row"),
					1,
					"the sync tier missed the open transaction",
				);
				const joined = tier.transaction((inner) => {
					insert(inner, "sync-transaction-row");
					return count(inner);
				});
				assert.equal(joined, 3);
				tier.exec("insert into t (id, name) values ('sync-exec-row', 'x')");
				assert.equal(await countAsync(tx, "sync-row"), 1);
				throw failed;
			}),
			(error) => error === failed,
		);
		// Every one of them went with the transaction's rollback.
		for (const id of [
			"async-row",
			"sync-row",
			"sync-transaction-row",
			"sync-exec-row",
		]) {
			assert.equal(count(tier, id), 0, `${id} outlived the rollback`);
		}
		// And committed with it when it commits.
		await db.transaction(async (tx) => {
			await insertAsync(tx, "async-committed");
			await sleep(5);
			insert(tier, "sync-committed");
		});
		assert.equal(count(tier, "async-committed"), 1);
		assert.equal(count(tier, "sync-committed"), 1);
	});

	test("S4: a sync call while an async transaction is open, from any other context, is a TypeError", async (tier, db) => {
		const inside = gate();
		const finish = gate();
		const open = db.transaction(async (tx) => {
			await insertAsync(tx, "open-row");
			inside.open();
			await finish.opened;
		});
		await inside.opened;

		let ran = false;
		try {
			assert.throws(
				() => tier.query("select 1 as one"),
				typeError(/async transaction/),
			);
			assert.throws(() => insert(tier, "stranger"), typeError(/async transaction/));
			assert.throws(
				() => tier.exec("insert into t (id, name) values ('stranger-exec', 'x')"),
				typeError(/async transaction/),
			);
			assert.throws(
				() =>
					tier.transaction(() => {
						ran = true;
					}),
				typeError(/async transaction/),
			);
			assert.equal(ran, false, "the refused transaction's callback ran");
		} finally {
			// A failed assertion fails the case; it must not leave the transaction open,
			// and the fixture's close() queued behind it, for ever.
			finish.open();
		}
		await open;
		// Once it has settled, the connection is free again.
		assert.equal(count(tier, "open-row"), 1);
		assert.equal(count(tier, "stranger"), 0);
		assert.equal(count(tier, "stranger-exec"), 0);
		insert(tier, "after");
		assert.equal(count(tier, "after"), 1);
	});

	test("S5: an async call from inside a sync transaction's callback rejects with a TypeError", async (tier, db) => {
		const answered: Promise<unknown>[] = [];
		const value = tier.transaction((tx) => {
			insert(tx, "sync-row");
			answered.push(
				promiseOf("query", () => insertAsync(db, "async-query")),
				promiseOf("exec", () =>
					db.exec("insert into t (id, name) values ('async-exec', 'x')"),
				),
				promiseOf("transaction", () =>
					db.transaction(async (inner) => {
						await insertAsync(inner, "async-transaction");
					}),
				),
				promiseOf("exclusive", () =>
					db.exclusive("lock", async (inner) => {
						await insertAsync(inner, "async-exclusive");
					}),
				),
				promiseOf("close", () => db.close()),
			);
			return "committed";
		});
		// Handled at once, so that none is left rejected without a handler.
		const refusals = answered.map((answer) =>
			assert.rejects(answer, typeError(/sync transaction/)),
		);
		assert.equal(value, "committed");
		await Promise.all(refusals);
		assert.equal(count(tier, "sync-row"), 1);
		for (const id of [
			"async-query",
			"async-exec",
			"async-transaction",
			"async-exclusive",
		]) {
			assert.equal(count(tier, id), 0, `${id} ran after all`);
		}
		// close() was refused: the driver still answers on both tiers.
		assert.equal(await countAsync(db, "sync-row"), 1);

		// The same from a sync transaction joined to an async one (S3).
		await db.transaction(async () => {
			let refused: Promise<unknown> | undefined;
			tier.transaction(() => {
				refused = promiseOf("query", () => insertAsync(db, "joined-async"));
			});
			await assert.rejects(
				refused ?? assert.fail("the joined callback did not run"),
				typeError(/sync transaction/),
			);
		});
		assert.equal(count(tier, "joined-async"), 0);
	});

	test("S6: a sync call while async statements are queued, and no transaction is open, runs at once", async (tier, db) => {
		const queued = [
			insertAsync(db, "queued-1"),
			db.transaction(async (tx) => {
				await insertAsync(tx, "queued-transaction");
			}),
			insertAsync(db, "queued-2"),
		];
		// Ahead of everything queued: none of it has run yet.
		assert.equal(count(tier), 0);
		insert(tier, "sync-first");
		tier.transaction((tx) => insert(tx, "sync-transaction"));
		tier.exec("insert into t (id, name) values ('sync-exec', 'x')");
		assert.equal(count(tier), 3);
		await Promise.all(queued);
		assert.equal(count(tier), 6);
	});
}
