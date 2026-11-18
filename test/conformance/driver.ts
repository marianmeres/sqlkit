// The `driver` conformance body: the contract's rules R1–R11 (plan doc 01 #2), at least one
// case per rule, and `checkHealth` on a live and on a closed driver (plan doc 03 #3), on
// every registered adapter (plan doc 02 #2). Ported from the prior
// implementation's driver conformance file
// (tmp/prior-art/engine/test/conformance/00-driver.test.ts), without its changeLock, json
// and likePrefix groups.
//
// Runner-agnostic: no `node:test` here, so the same cases run inside workerd. Every case
// creates and disposes a database of its own. The SQL is portable between the dialects or
// written as `sql` fragments, which render each dialect's placeholders; where the rule
// itself differs by dialect (R3's aborted transaction, R10's parameter table), the case
// says so and asserts each side.

import assert from "node:assert/strict";
import {
	checkHealth,
	type Driver,
	SqlError,
	sql,
	TransactionAbortedError,
} from "../../src/mod.ts";
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

/** A rejection that is a `TypeError`, whose message matches `pattern` when one is given. */
function typeError(pattern?: RegExp): (error: unknown) => boolean {
	return (error) =>
		error instanceof TypeError &&
		(pattern === undefined || pattern.test(error.message));
}

const READ_ONLY = /read-?only/i;

/** `insert into t` one row, through whichever handle the caller is in. */
function insert(db: Driver, id: string, name = id): Promise<unknown> {
	return db.query(sql`insert into t (id, name) values (${id}, ${name})`);
}

/** Rows of `t`, or rows of `t` with `id`. `count(*)` is text on Postgres, hence `Number`. */
async function count(db: Driver, id?: string): Promise<number> {
	const { rows } = await db.query<{ c: number | string }>(
		id === undefined
			? sql`select count(*) as c from t`
			: sql`select count(*) as c from t where id = ${id}`,
	);
	return Number(rows[0]?.c ?? -1);
}

export function driverContract(suite: Suite, adapter: AdapterCase): void {
	/** One case, on a database of its own holding an empty table `t`. */
	const test = (name: string, body: (db: Driver) => Promise<void>): void => {
		suite.test(name, async () => {
			const fixture = await adapter.create();
			try {
				await fixture.driver.query(
					"create table t (id text primary key, name text not null)",
				);
				await body(fixture.driver);
			} finally {
				await fixture.dispose();
			}
		});
	};

	// ── R1: always a promise ────────────────────────────────────────────────────────

	test("R1: query and exec answer with a promise", async (db) => {
		const answered = await promiseOf("query", () => db.query("select 1 as one"));
		assert.deepEqual(answered, { rows: [{ one: 1 }], rowCount: 1 });
		assert.equal(await promiseOf("exec", () => db.exec("select 1")), undefined);
	});

	test("R1: a failing statement rejects, and never throws at the call", async (db) => {
		await assert.rejects(
			promiseOf("query", () => db.query("select * from no_such_table")),
		);
		await insert(db, "dup");
		await assert.rejects(promiseOf("query", () => insert(db, "dup")));
		await assert.rejects(
			promiseOf("exec", () => db.exec("insert into no_such_table values (1)")),
		);
		// The same inside a transaction, which the callback then abandons: on Postgres
		// the failed statement has aborted it anyway.
		const abandoned = new Error("abandoned");
		await assert.rejects(
			db.transaction(async (tx) => {
				await assert.rejects(
					promiseOf("tx.query", () => tx.query("select * from no_such_table")),
				);
				throw abandoned;
			}),
			(error) => error === abandoned,
		);
	});

	test("R1: a refused call rejects with a TypeError, and never throws", async (db) => {
		// Past the overloads, as untyped code would call it: a fragment and params.
		const loose = db.query as (statement: unknown, params?: unknown) => unknown;
		await assert.rejects(
			promiseOf("query", () => loose.call(db, sql`select ${1} as n`, [1])),
			typeError(/takes no params/),
		);
		await assert.rejects(
			promiseOf("query", () => db.query(42 as unknown as string)),
			typeError(),
		);
		await assert.rejects(
			promiseOf("exec", () => db.exec(undefined as unknown as string)),
			typeError(),
		);
		await assert.rejects(
			promiseOf("transaction", () => db.transaction(null as never)),
			typeError(),
		);
		await assert.rejects(
			promiseOf("exclusive", () => db.exclusive("lock", "fn" as never)),
			typeError(),
		);
		// Nothing was left open or queued by a refusal: the connection still answers.
		assert.equal(await count(db), 0);
	});

	// ── R2: rowCount ────────────────────────────────────────────────────────────────

	test("R2: rowCount counts the rows a statement returns, or the rows it affected", async (db) => {
		assert.deepEqual(
			await db.query(
				"insert into t (id, name) values ('a', 'a'), ('b', 'b'), ('c', 'c')",
			),
			{
				rows: [],
				rowCount: 3,
			},
		);
		const all = await db.query("select id from t order by id");
		assert.deepEqual(all, {
			rows: [{ id: "a" }, { id: "b" }, { id: "c" }],
			rowCount: 3,
		});
		assert.deepEqual(await db.query("select id from t where id = 'z'"), {
			rows: [],
			rowCount: 0,
		});
		assert.deepEqual(
			await db.query("update t set name = 'x' where id in ('a', 'b')"),
			{ rows: [], rowCount: 2 },
		);
		assert.deepEqual(await db.query("update t set name = 'x' where id = 'z'"), {
			rows: [],
			rowCount: 0,
		});
		assert.deepEqual(await db.query("delete from t where id = 'c'"), {
			rows: [],
			rowCount: 1,
		});
	});

	test("R2: a write with RETURNING counts the rows it returns", async (db) => {
		assert.deepEqual(
			await db.query(
				"insert into t (id, name) values ('d', 'd'), ('e', 'e') returning id",
			),
			{ rows: [{ id: "d" }, { id: "e" }], rowCount: 2 },
		);
		assert.deepEqual(
			await db.query("update t set name = 'y' where id = 'd' returning id, name"),
			{ rows: [{ id: "d", name: "y" }], rowCount: 1 },
		);
		assert.deepEqual(await db.query("delete from t where id = 'z' returning id"), {
			rows: [],
			rowCount: 0,
		});
		assert.deepEqual(await db.query("delete from t where id = 'e' returning id"), {
			rows: [{ id: "e" }],
			rowCount: 1,
		});
	});

	// ── R3: commit and rollback ─────────────────────────────────────────────────────

	test("R3: a transaction commits when its callback resolves, and answers its value", async (db) => {
		const answer = await db.transaction(async (tx) => {
			await insert(tx, "committed");
			return "answer";
		});
		assert.equal(answer, "answer");
		assert.equal(await count(db, "committed"), 1);
	});

	test("R3: a transaction rolls back when its callback rejects, with that rejection", async (db) => {
		const boom = new Error("boom");
		await assert.rejects(
			db.transaction(async (tx) => {
				await insert(tx, "rolled-back");
				assert.equal(
					await count(tx, "rolled-back"),
					1,
					"the write is visible inside its own transaction",
				);
				throw boom;
			}),
			(error) => error === boom,
		);
		assert.equal(await count(db, "rolled-back"), 0);
	});

	test("R3: a failed statement the callback swallowed: SQLite commits the rest, Postgres rejects", async (db) => {
		const outcome = db.transaction(async (tx) => {
			await insert(tx, "kept");
			await assert.rejects(insert(tx, "kept"), "a duplicate was accepted");
			return "swallowed";
		});
		if (db.dialect === "sqlite") {
			// SQLite has no aborted state: the failed statement is undone, the rest stays.
			assert.equal(await outcome, "swallowed");
			assert.equal(await count(db, "kept"), 1);
		} else {
			// Postgres aborted the transaction: a COMMIT would be answered with ROLLBACK.
			// Every adapter says so the same way, whether it read the COMMIT's answer or
			// never sent one.
			await assert.rejects(
				outcome,
				(error) =>
					error instanceof TransactionAbortedError &&
					error.kind === "aborted" &&
					error.dialect === "pg",
			);
			assert.equal(await count(db, "kept"), 0);
		}
	});

	// ── R4: nesting ─────────────────────────────────────────────────────────────────

	test("R4: a nested transaction joins the open one", async (db) => {
		const failed = new Error("outer failed");
		await assert.rejects(
			db.transaction(async (tx) => {
				await insert(tx, "outer");
				const inner = await tx.transaction(async (nested) => {
					assert.equal(
						nested,
						db,
						"the nested callback was handed another handle",
					);
					await insert(nested, "inner");
					return "inner value";
				});
				assert.equal(inner, "inner value");
				assert.equal(await count(tx, "inner"), 1);
				throw failed;
			}),
			(error) => error === failed,
		);
		// The nested block returned without committing anything of its own.
		assert.equal(await count(db, "outer"), 0);
		assert.equal(await count(db, "inner"), 0);
	});

	test("R4: a nested transaction is the open one as it was opened", async (db) => {
		// Read-only nested in a write transaction: it is that transaction, and writes.
		await db.transaction(async (tx) => {
			await insert(tx, "nested-read-only");
			await tx.transaction(
				async (inner) => {
					assert.equal(await count(inner, "nested-read-only"), 1);
					await insert(inner, "written-inside");
				},
				{ readOnly: true },
			);
		});
		assert.equal(await count(db, "written-inside"), 1);
		// A write nested in a read-only transaction is refused with it.
		await assert.rejects(
			db.transaction(
				(tx) => tx.transaction((inner) => insert(inner, "nested-write")),
				{ readOnly: true },
			),
			READ_ONLY,
		);
		assert.equal(await count(db, "nested-write"), 0);
	});

	// ── R5: whose transaction a statement is in ─────────────────────────────────────
	//
	// Each case holds a transaction open across a real timer, not a resolved promise: a
	// statement only has a chance to land in another caller's transaction when that
	// transaction waits on something outside the database, and microtasks alone would not
	// show it.

	test("R5: a statement from outside an open transaction neither sees it nor goes with it", async (db) => {
		const inside = gate();
		const failed = new Error("the other caller failed");
		const other = db.transaction(async (tx) => {
			await insert(tx, "uncommitted");
			inside.open();
			await sleep(30);
			throw failed;
		});
		const refused = assert.rejects(other, (error) => error === failed);
		await inside.opened;

		// This caller is in no transaction. A pool runs it on another connection; a single
		// connection runs it after the open transaction ends.
		const [seen] = await Promise.all([
			count(db, "uncommitted"),
			insert(db, "stranger"),
		]);
		await refused;

		assert.equal(seen, 0, "a stranger saw another caller's uncommitted row");
		assert.equal(await count(db, "uncommitted"), 0);
		assert.equal(
			await count(db, "stranger"),
			1,
			"a stranger's write went with another caller's rollback",
		);
	});

	test("R5: a transaction from outside an open one is a transaction of its own", async (db) => {
		const inside = gate();
		const failed = new Error("the first failed");
		const first = db.transaction(async (tx) => {
			await insert(tx, "first");
			inside.open();
			await sleep(30);
			throw failed;
		});
		const refused = assert.rejects(first, (error) => error === failed);
		await inside.opened;
		const seen = await db.transaction(async (tx) => {
			await insert(tx, "second");
			return count(tx, "first");
		});
		await refused;
		assert.equal(seen, 0, "the second transaction saw the first one's row");
		assert.equal(await count(db, "first"), 0);
		assert.equal(await count(db, "second"), 1, "the second went with the first");
	});

	// ── R6: inside ends when the callback settles ───────────────────────────────────

	test("R6: a promise that outlives its transaction writes outside it", async (db) => {
		const released = gate();
		let straggler: Promise<void> | undefined;
		await db.transaction(async (tx) => {
			await insert(tx, "owner");
			// Started inside the callback and not awaited by it: it carries this
			// transaction's context past the commit.
			straggler = (async (): Promise<void> => {
				await released.opened;
				await insert(db, "late-query");
				await db.exec("insert into t (id, name) values ('late-exec', 'late')");
				await db.transaction(async (late) => {
					await insert(late, "late-transaction");
				});
			})();
		});
		assert.equal(await count(db, "owner"), 1);

		// An unrelated transaction is open while the straggler writes, and then fails.
		const failed = new Error("unrelated failed");
		const unrelated = db.transaction(async (tx) => {
			await insert(tx, "unrelated");
			released.open();
			await sleep(30);
			throw failed;
		});
		await assert.rejects(unrelated, (error) => error === failed);
		await straggler;

		assert.equal(await count(db, "unrelated"), 0);
		for (const id of ["late-query", "late-exec", "late-transaction"]) {
			assert.equal(
				await count(db, id),
				1,
				`${id}: issued from an ended transaction's context, it joined another one`,
			);
		}
	});

	// ── R7: read-only ───────────────────────────────────────────────────────────────

	test("R7: a read-only transaction reads one snapshot while another caller writes", async (db) => {
		const entered = gate();
		const proceed = gate();
		const reader = db.transaction(
			async (tx) => {
				const before = await count(tx);
				entered.open();
				await proceed.opened;
				return [before, await count(tx)] as const;
			},
			{ readOnly: true },
		);
		await entered.opened;
		// Another caller, outside it. Where a statement outside a transaction runs beside
		// it, the write commits while the reader is open; on a single connection it queues
		// behind the reader, so there it can only be awaited once the reader is done.
		const writer = insert(db, "snapshot-writer");
		if (db.capabilities.concurrentWriters) {
			await writer;
			assert.equal(await count(db, "snapshot-writer"), 1);
		}
		proceed.open();
		const [before, after] = await reader;
		await writer;
		assert.equal(after, before, "a read-only transaction saw a later commit");
		assert.equal(await count(db, "snapshot-writer"), 1);
	});

	test("R7: a read-only transaction refuses a write; the connection writes again after it", async (db) => {
		await assert.rejects(
			db.transaction((tx) => insert(tx, "read-only-write"), { readOnly: true }),
			READ_ONLY,
		);
		await assert.rejects(
			db.transaction(
				(tx) =>
					tx.exec("insert into t (id, name) values ('read-only-exec', 'x')"),
				{ readOnly: true },
			),
			READ_ONLY,
		);
		assert.equal(await count(db), 0);
		await insert(db, "after-read-only");
		assert.equal(await count(db, "after-read-only"), 1);
		// A read-only transaction that only reads commits, and answers.
		assert.equal(await db.transaction((tx) => count(tx), { readOnly: true }), 1);

		// Anything but a boolean is refused, with a promise like every other refusal.
		await assert.rejects(
			promiseOf("transaction", () =>
				db.transaction(async () => undefined, {
					readOnly: "yes" as unknown as boolean,
				}),
			),
			typeError(/readOnly/),
		);
	});

	// ── R8: exclusive ───────────────────────────────────────────────────────────────

	test("R8: exclusive serializes two callers of one name", async (db) => {
		const seen: string[] = [];
		const holding = gate();
		const release = gate();
		const first = db.exclusive("lock", async () => {
			seen.push("first in");
			holding.open();
			await release.opened;
			seen.push("first out");
		});
		await holding.opened;
		const second = db.exclusive("lock", async (tx) => {
			seen.push("second in");
			await insert(tx, "exclusive-second");
			return "second";
		});
		// Long enough for a lock that did not exclude to have let `second` in.
		await sleep(60);
		assert.deepEqual(seen, ["first in"]);
		release.open();
		assert.equal((await Promise.all([first, second]))[1], "second");
		assert.deepEqual(seen, ["first in", "first out", "second in"]);
		assert.equal(await count(db, "exclusive-second"), 1);
	});

	test("R8: exclusive is re-entrant, and two names do not wait for each other", async (db) => {
		const answer = await db.exclusive("outer", (tx) =>
			tx.exclusive("outer", async () => {
				// Another name, taken and released while this one is held elsewhere.
				const elsewhere = gate();
				const done = gate();
				const held = db.exclusive("other", async () => {
					elsewhere.open();
					await done.opened;
				});
				await elsewhere.opened;
				const free = await db.exclusive("third", async () => "free");
				done.open();
				await held;
				return free;
			}),
		);
		assert.equal(answer, "free");
	});

	test("R8: exclusive releases on a rejection, and runs a transaction inside it", async (db) => {
		const failed = new Error("inside failed");
		await assert.rejects(
			db.exclusive("lock", async () => {
				throw failed;
			}),
			(error) => error === failed,
		);
		await db.exclusive("lock", async (tx) => {
			await tx.transaction(async (inner) => {
				await insert(inner, "exclusive-tx");
			});
			await assert.rejects(
				tx.transaction(async (inner) => {
					await insert(inner, "exclusive-rolled-back");
					throw new Error("rolled back");
				}),
				/rolled back/,
			);
			// A statement after the transaction: on the same footing as before it.
			await insert(tx, "exclusive-after");
		});
		assert.equal(await count(db, "exclusive-tx"), 1);
		assert.equal(await count(db, "exclusive-rolled-back"), 0);
		assert.equal(await count(db, "exclusive-after"), 1);
		await assert.rejects(
			promiseOf("exclusive", () => db.exclusive("", async () => undefined)),
			typeError(/lock name/),
		);
	});

	test("R8: exclusive inside an open transaction belongs to that transaction", async (db) => {
		const failed = new Error("the transaction failed");
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.exclusive("lock", async (inner) => {
					await insert(inner, "exclusive-in-tx");
					// Re-entrant there too.
					await inner.exclusive("lock", async () => undefined);
				});
				throw failed;
			}),
			(error) => error === failed,
		);
		assert.equal(await count(db, "exclusive-in-tx"), 0);
		// And the lock went with the transaction: the next caller is not kept waiting.
		assert.equal(await db.exclusive("lock", async () => "next"), "next");
	});

	// ── R9: exec ────────────────────────────────────────────────────────────────────

	test("R9: exec runs every statement of a script", async (db) => {
		await db.exec(
			[
				"insert into t (id, name) values ('script-1', 'a');",
				"create table u (id text primary key);",
				"insert into t (id, name) values ('script-2', 'b'), ('script-3', 'c');",
				"insert into u (id) values ('u-1');",
			].join("\n"),
		);
		assert.equal(await count(db), 3);
		const { rows } = await db.query("select id from u");
		assert.deepEqual(rows, [{ id: "u-1" }]);
	});

	test("R9: exec joins the open transaction, and a stranger's exec does not", async (db) => {
		const inside = gate();
		const failed = new Error("rolled back");
		const open = db.transaction(async (tx) => {
			await tx.exec(
				"insert into t (id, name) values ('exec-in-tx-1', 'a'), ('exec-in-tx-2', 'b')",
			);
			assert.equal(await count(tx), 2);
			inside.open();
			await sleep(30);
			throw failed;
		});
		const refused = assert.rejects(open, (error) => error === failed);
		await inside.opened;
		await db.exec("insert into t (id, name) values ('exec-stranger', 'c')");
		await refused;
		assert.equal(await count(db, "exec-in-tx-1"), 0);
		assert.equal(await count(db, "exec-in-tx-2"), 0);
		assert.equal(await count(db, "exec-stranger"), 1);
	});

	// ── R11: one statement per query ────────────────────────────────────────────────

	test("R11: query refuses a text of several statements, and none of it runs", async (db) => {
		// node:sqlite would run the first and drop the rest; a simple query on Postgres
		// would run them all. Refused before either: a TypeError where the adapter sees
		// it, the database's own refusal where the database does.
		const refused = (error: unknown) =>
			error instanceof TypeError || error instanceof SqlError;
		await assert.rejects(
			promiseOf("query(two statements)", () =>
				db.query(
					"insert into t (id, name) values ('first', 'a'); insert into t (id, name) values ('second', 'b')",
				),
			),
			refused,
		);
		await assert.rejects(
			db.transaction((tx) =>
				tx.query(
					"insert into t (id, name) values ('in-tx', 'a');\n-- a comment\nselect 1",
				),
			),
			refused,
		);
		assert.equal(await count(db), 0);
		// What may follow the one statement: blanks, semicolons and comments.
		const { rows } = await db.query("select 1 as one; ;\n-- done\n/* really */ ");
		assert.deepEqual(rows, [{ one: 1 }]);
	});

	// ── R10: parameters and rows ────────────────────────────────────────────────────

	test("R10: values bind by the parameter rule, the same on both dialects", async (db) => {
		const { rows } = await db.query<Record<string, unknown>>(
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
		// What no database can bind is refused before one sees it, with a promise.
		await assert.rejects(
			promiseOf("query", () => db.query(sql`select ${() => 1} as f`)),
			typeError(),
		);
		await assert.rejects(
			promiseOf("query", () => db.query(sql`select ${new Map()} as m`)),
			typeError(),
		);
	});

	test("R10: the dialect's own cells: booleans, dates, arrays and bytes", async (db) => {
		const date = new Date("2026-01-02T03:04:05.000Z");
		if (db.dialect === "sqlite") {
			const { rows } = await db.query<Record<string, unknown>>(
				sql`select ${true} as yes, ${false} as no,
					${date} as d, typeof(${date}) as d_type,
					${new Uint8Array([1, 2, 3])} as bytes`,
			);
			assert.deepEqual(
				{ ...rows[0], bytes: Array.from(rows[0]?.bytes as Uint8Array) },
				{
					yes: 1,
					no: 0,
					d: "2026-01-02T03:04:05.000Z",
					d_type: "text",
					bytes: [1, 2, 3],
				},
			);
			await assert.rejects(
				promiseOf("query", () => db.query(sql`select ${[1, 2]} as a`)),
				typeError(/json\(\)|inList/),
			);
		} else {
			const { rows } = await db.query<Record<string, unknown>>(
				sql`select
					case when cast(${date} as timestamptz)
						= cast('2026-01-02T03:04:05.000Z' as timestamptz) then 1 else 0 end as same_instant,
					cast(${[1, 2]} as integer[]) as a`,
			);
			assert.deepEqual(rows, [{ same_instant: 1, a: [1, 2] }]);
		}
	});

	test("R10: bytes bound as a Uint8Array read back as one", async (db) => {
		// A `Buffer` (node-postgres) is a `Uint8Array`; an `ArrayBuffer` (workerd) is not.
		const bytes = new Uint8Array([0, 1, 254, 255]);
		const { rows } = await db.query<{ b: unknown }>(
			db.dialect === "pg"
				? sql`select cast(${bytes} as bytea) as b`
				: sql`select ${bytes} as b`,
		);
		const read = rows[0]?.b;
		assert.ok(
			read instanceof Uint8Array,
			`read back ${Object.prototype.toString.call(read)}`,
		);
		assert.deepEqual(Array.from(read), [0, 1, 254, 255]);
	});

	test("R10: rows are plain objects", async (db) => {
		await insert(db, "plain", "row");
		const { rows } = await db.query("select id, name from t");
		assert.equal(rows.length, 1);
		for (const row of rows) {
			assert.equal(Object.getPrototypeOf(row), Object.prototype);
		}
		assert.deepEqual(rows, [{ id: "plain", name: "row" }]);
		const returned = await db.query(
			"insert into t (id, name) values ('returned', 'r') returning id",
		);
		assert.equal(Object.getPrototypeOf(returned.rows[0]), Object.prototype);
	});

	// Health (plan doc 03 #3): the one `select 1` a check sends runs on every adapter, and a
	// driver that can no longer answer is reported, not thrown.
	test("health: a live driver is healthy", async (db) => {
		const status = await checkHealth(db);
		assert.equal(status.healthy, true);
		assert.equal(status.error, null);
		assert.equal(typeof status.latencyMs, "number");
		assert.ok((status.latencyMs ?? -1) >= 0);
		assert.ok(status.checkedAt instanceof Date);
	});

	test("health: a closed driver is unhealthy, and the check still resolves", async (db) => {
		await db.close();
		const status = await checkHealth(db);
		assert.equal(status.healthy, false);
		assert.equal(status.latencyMs, null);
		assert.ok(status.error instanceof SqlError, String(status.error));
		assert.equal(status.error.dialect, db.dialect);
	});
}
