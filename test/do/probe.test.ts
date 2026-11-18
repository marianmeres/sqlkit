// The Durable Objects spike (plan doc 02 #1), run in real workerd through `_workerd.ts`.
//
// Assumptions A1–A6 are what the design rests on: each is asserted, and a failure means the
// single-connection core is wrong for Durable Objects, not that the test needs adjusting.
// Probes P1–P8 are questions: each answer is printed as a diagnostic and pinned, so a
// workerd upgrade that changes one fails here first. Every answer is written up, with the
// workerd version it was observed on, in the archived plan set's DO-FINDINGS.md,
// `docs/_archive/plans/v0-foundation/DO-FINDINGS.md` (F01–F06 for the assumptions,
// F07–F14 for the probes); change the two together.
//
// This file is adapter-specific by nature: it asks the runtime, not an adapter, so it has
// no conformance body.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, type TestContext, test } from "node:test";
import { startWorkerd, type Workerd } from "./_workerd.ts";

const ENTRY = join(import.meta.dirname, "worker", "probe.ts");

let workerd: Workerd | undefined;

before(async () => {
	workerd = await startWorkerd(ENTRY);
});

after(async () => {
	if (!workerd) return;
	await workerd.dispose();
	// nothing left behind: the port workerd listened on refuses connections
	await assert.rejects(fetch(workerd.url), "workerd still answers after dispose()");
});

function call(name: string, payload?: unknown, object?: string): Promise<unknown> {
	assert.ok(workerd, "workerd did not start");
	return workerd.call(name, payload, object === undefined ? {} : { object });
}

/** Prints a probe's answer into the test report, where a reader of the run sees it. */
function record(t: TestContext, answer: unknown): void {
	t.diagnostic(`workerd ${workerd?.version}: ${JSON.stringify(answer)}`);
}

/** What workerd says to any transaction statement sent through `sql.exec` (F04). */
const TRANSACTION_STATEMENT_REFUSAL =
	"To execute a transaction, please use the state.storage.transaction() or " +
	"state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or " +
	"SAVEPOINT statements. The JavaScript API is safer because it will automatically roll " +
	"back on exceptions, and because it interacts correctly with Durable Objects' automatic " +
	"atomic write coalescing.";

describe("do/probe: assumptions", () => {
	test("A1 (F01): sql.exec is synchronous and runs every statement of a script", async () => {
		assert.deepEqual(await call("a1"), { returnsThenable: false, a: [1], b: [2, 3] });
	});

	test("A2 (F02): transactionSync returns fn's value and rolls back when fn throws", async () => {
		assert.deepEqual(await call("a2"), {
			sameValue: true,
			sameError: true,
			rows: ["committed"],
		});
	});

	test("A3 (F03): the async transaction holds sql.exec writes across an await, rolls back on rejection", async () => {
		const committed = ["before timer", "after timer", "after microtask"];
		assert.deepEqual(await call("a3"), {
			value: "resolved",
			committed,
			seenInside: [...committed, "undone before timer", "undone after timer"],
			afterRollback: committed,
			sameError: true,
		});
	});

	test("A4 (F04): BEGIN and SAVEPOINT through sql.exec are refused", async () => {
		const answer = (await call("a4")) as Record<
			string,
			{ refused: boolean; error?: string }
		>;
		assert.deepEqual(Object.keys(answer).sort(), [
			"BEGIN",
			"BEGIN EXCLUSIVE",
			"BEGIN IMMEDIATE",
			"BEGIN TRANSACTION",
			"COMMIT",
			"END",
			"RELEASE sp",
			"ROLLBACK",
			"ROLLBACK TO sp",
			"SAVEPOINT sp",
		]);
		for (const [statement, result] of Object.entries(answer)) {
			assert.deepEqual(
				result,
				{ refused: true, error: TRANSACTION_STATEMENT_REFUSAL },
				statement,
			);
		}
	});

	test("A5 (F05): AsyncLocalStorage under nodejs_compat keeps its store inside the async transaction", async () => {
		assert.deepEqual(await call("a5"), {
			atStart: "outer",
			inside: {
				before: "outer",
				afterTimer: "outer",
				afterMicrotask: "outer",
				nested: { afterTimer: "inner", afterMicrotask: "inner" },
				afterNested: "outer",
			},
			afterTransaction: "outer",
		});
	});

	test("A6 (F06): node:assert/strict is importable under nodejs_compat", async () => {
		assert.deepEqual(await call("a6"), {
			name: "AssertionError",
			code: "ERR_ASSERTION",
			isAssertionError: true,
			strictEqualityRefusesCoercion: true,
		});
	});
});

describe("do/probe: probes", () => {
	test("P1 (F07): transactionSync nests; an inner throw undoes only the inner part", async (t) => {
		const answer = await call("p1");
		record(t, answer);
		assert.deepEqual(answer, {
			nested: { ok: true, value: "inner value" },
			afterNested: ["outer 1", "inner", "outer 2"],
			innerThrows: { ok: true, value: "outer value" },
			innerError: "inner boom",
			afterInnerThrows: ["outer 1", "outer 2"],
		});
	});

	test("P2 (F08): the async transaction nests; an inner rejection undoes only the inner part", async (t) => {
		const answer = await call("p2");
		record(t, answer);
		assert.deepEqual(answer, {
			nested: { ok: true, value: "inner value" },
			afterNested: ["outer 1", "inner", "outer 2"],
			innerRejects: { ok: true, value: "outer value" },
			innerError: "inner boom",
			afterInnerRejects: ["outer 1", "outer 2"],
		});
	});

	test("P3 (F09): which values bind, and as what", async (t) => {
		const answer = await call("p3");
		record(t, answer);
		const binds = (sqliteType: string, js: string, value: unknown) => ({
			binds: true,
			sqliteType,
			returned: { js, value },
		});
		const bigint = {
			binds: false,
			error: "Cannot convert a BigInt value to a number",
		};
		assert.deepEqual(answer, {
			null: binds("null", "null", null),
			string: binds("text", "string", "text"),
			integer: binds("real", "number", 42),
			float: binds("real", "number", 1.5),
			unsafeInteger: binds("real", "number", 2 ** 53 + 2),
			arrayBuffer: binds("blob", "ArrayBuffer", [1, 2, 3]),
			booleanTrue: binds("text", "string", "true"),
			booleanFalse: binds("text", "string", "false"),
			date: binds(
				"text",
				"string",
				"Fri Jan 02 2026 03:04:05 GMT+0000 (Coordinated Universal Time)",
			),
			bigint,
			bigintLarge: bigint,
			uint8Array: binds("blob", "ArrayBuffer", [1, 2, 3]),
			undefined: binds("null", "null", null),
			plainObject: binds("text", "string", "[object Object]"),
			array: binds("text", "string", "1,2"),
			integerIntoIntegerColumn: "integer",
			integerAsLimit: { binds: true, rows: 1 },
		});
	});

	test("P4 (F10): changes() is the affected-row count; rowsWritten counts index writes too", async (t) => {
		const answer = await call("p4");
		record(t, answer);
		const count = (rowsWritten: number, changes: number, rows = 0) => ({
			rowsWrittenBeforeRead: rowsWritten,
			rowsWrittenAfterRead: rowsWritten,
			changes,
			rows,
		});
		assert.deepEqual(answer, {
			plain: {
				insert3: count(3, 3),
				update2: count(2, 2),
				update0: count(0, 0),
				updateReturning3: count(3, 3, 3),
				delete1: count(1, 1),
				select: count(0, 1, 2),
				ddl: count(2, 1),
			},
			indexed: {
				insert3: count(6, 3),
				update2: count(4, 2),
				update0: count(0, 0),
				updateReturning3: count(6, 3, 3),
				delete1: count(1, 1),
				select: count(0, 1, 2),
				ddl: count(2, 1),
			},
		});
	});

	test("P5 (F11): a constraint violation is a plain Error whose message carries the codes", async (t) => {
		const answer = (await call("p5")) as Record<
			string,
			{ threw: boolean; error: Record<string, unknown> }
		>;
		const seen: Record<string, unknown> = {};
		for (const [label, { threw, error }] of Object.entries(answer)) {
			const { stack: _stack, ...rest } = error;
			seen[label] = { threw, ...rest };
		}
		record(t, seen);
		const plainError = (message: string) => ({
			threw: true,
			name: "Error",
			message,
			constructorName: "Error",
			isError: true,
			ownProperties: ["message", "stack"],
			fields: {},
		});
		assert.deepEqual(seen, {
			unique: plainError(
				"UNIQUE constraint failed: child.code: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
			),
			foreignKey: plainError(
				"FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
			),
			notNull: plainError(
				"NOT NULL constraint failed: child.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)",
			),
			check: plainError(
				"CHECK constraint failed: qty_positive: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
			),
			syntax: plainError('near "selec": syntax error at offset 0: SQLITE_ERROR'),
		});
	});

	test("P6 (F12): foreign keys are on for good; PRAGMA query_only is not authorized", async (t) => {
		const answer = await call("p6");
		record(t, answer);
		const fkRefusal =
			"FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)";
		const unauthorized = { permitted: false, error: "not authorized: SQLITE_AUTH" };
		assert.deepEqual(answer, {
			foreignKeysDefault: { permitted: true, rows: [{ foreign_keys: 1 }] },
			orphanByDefault: { refused: true, error: fkRefusal },
			foreignKeysOff: { permitted: true, rows: [] },
			foreignKeysAfterOff: { permitted: true, rows: [{ foreign_keys: 1 }] },
			orphanAfterOff: { refused: true, error: fkRefusal },
			foreignKeysOn: { permitted: true, rows: [] },
			deferForeignKeys: { permitted: true, rows: [] },
			queryOnlyDefault: unauthorized,
			queryOnlyOn: unauthorized,
			queryOnlyAfterOn: unauthorized,
			writeWhileQueryOnly: { refused: false },
			queryOnlyOff: unauthorized,
			writeAfterQueryOnlyOff: { refused: false },
			parents: [{ id: 2 }, { id: 3 }],
		});
	});

	test("P7 (F13): sqlite_version() is not authorized; RETURNING and ON CONFLICT work", async (t) => {
		const answer = await call("p7");
		record(t, answer);
		const notAuthorized = (fn: string) => ({
			works: false,
			error: `not authorized to use function: ${fn} at offset 7: SQLITE_ERROR`,
		});
		assert.deepEqual(answer, {
			version: notAuthorized("sqlite_version"),
			sinceRelease: {
				"3.38.0 ->>": { works: true, value: 1 },
				"3.38.0 unixepoch()": { works: true, value: 1767225600 },
				"3.44.0 concat()": { works: true, value: "ab" },
				"3.45.0 jsonb()": { works: true, value: "blob" },
				"3.46.0 json_pretty()": notAuthorized("json_pretty"),
				"3.50.0 unistr()": {
					works: false,
					error: "no such function: unistr at offset 7: SQLITE_ERROR",
				},
			},
			returning: { ok: true, value: [{ id: 1, k: "a", v: 1 }] },
			onConflictDoNothing: { ok: true, value: [] },
			onConflictDoUpdate: { ok: true, value: [{ k: "a", v: 3 }] },
			rows: [{ k: "a", v: 3 }],
		});
	});

	test("P8 (F14): a second request waits for an open async transaction, even one awaiting a timer", async (t) => {
		// `hold` awaits a timer for HOLD_MS; `peek` is sent DELAY_MS after it, to the same
		// object. The control runs first, with no transaction, and shows that `peek` is
		// delivered in time when nothing holds it back.
		const HOLD_MS = 800;
		const DELAY_MS = 200;
		const run = async (transaction: boolean) => {
			const object = `p8-${transaction ? "transaction" : "control"}-${randomUUID()}`;
			await call("p8-setup", null, object);
			const order: string[] = [];
			const settled = (label: string) => (value: unknown) => {
				order.push(label);
				return value;
			};
			const hold = call(
				"p8-hold",
				{ ms: HOLD_MS, key: object, transaction },
				object,
			).then(settled("hold"));
			await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
			const peek = call("p8-peek", { key: object }, object).then(settled("peek"));
			const [held, peeked] = await Promise.all([hold, peek]);
			const read = await call("p8-read", null, object);
			return { hold: held, peek: peeked, order, read };
		};

		const control = await run(false);
		const inTransaction = await run(true);
		record(t, { control, inTransaction });

		const peekOf = (outcome: { peek: unknown }) =>
			(outcome.peek as { hold: string }).hold;
		assert.notEqual(
			peekOf(control),
			"not started",
			"inconclusive: peek reached the object before hold did; raise DELAY_MS",
		);
		assert.deepEqual(control, {
			hold: { seenAfterTimer: ["hold", "peek"] },
			peek: { hold: "awaiting timer", seen: ["hold"] },
			order: ["peek", "hold"],
			read: { rows: ["hold", "peek"] },
		});
		// That `peek` ran only once `hold` had finished is `peek.hold`, read inside the
		// object. Which of the two responses then reaches Node first is not pinned: both are
		// released together, and under load either arrives first (seen at T19).
		const { order, ...held } = inTransaction;
		assert.deepEqual(held, {
			hold: { seenAfterTimer: ["hold"] },
			peek: { hold: "finished", seen: [] },
			read: { rows: ["peek"] },
		});
		assert.deepEqual([...order].sort(), ["hold", "peek"]);
	});

	test("P9 (F15): a deferred foreign key is checked when the request ends, and a violation resets the object", async (t) => {
		// What a call answers: its value, or the message it was refused with.
		const outcome = (name: string, payload: unknown, object: string) =>
			call(name, payload, object).then(
				(value) => ({ value }),
				(error: unknown) => ({ refused: String((error as Error).message) }),
			);
		const answers: Record<string, unknown> = {};
		const refusals: Record<string, string> = {};
		for (const mode of ["sync", "async", "bare", "fix"]) {
			const object = `p9-${mode}-${randomUUID()}`;
			await call("p9-setup", null, object);
			const answer =
				mode === "fix"
					? await outcome("p9-fix", null, object)
					: await outcome("p9-violate", { mode }, object);
			if ("refused" in answer) refusals[mode] = answer.refused;
			answers[mode] = {
				answer: "refused" in answer ? "refused" : answer.value,
				after: await call("p9-read", null, object),
			};
		}
		record(t, { answers, refusals });

		// Every violating mode fails the request after its handler returned (HTTP 500, no
		// JSON envelope: nothing threw where the handler could see it), and the object is
		// back to the state before that request: no orphan, the parent still there.
		const before = { children: 0, parents: 1 };
		assert.deepEqual(answers, {
			sync: { answer: "refused", after: before },
			async: { answer: "refused", after: before },
			bare: { answer: "refused", after: before },
			fix: { answer: { returned: "fix" }, after: { children: 1, parents: 2 } },
		});
		const reset =
			"Durable Object was reset and rolled back to its last known good state because " +
			"the application left the database in a state where constraints were violated: " +
			"FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)";
		for (const mode of ["sync", "bare"]) {
			assert.ok(
				refusals[mode]?.startsWith(
					`p9-violate: HTTP 500, not JSON: Error: ${reset}`,
				),
				`${mode}: ${refusals[mode]}`,
			);
		}
		// The async transaction's request fails with an opaque internal error instead.
		assert.match(
			refusals.async ?? "",
			/^p9-violate: HTTP 500, not JSON: Error: internal error; reference = \w+/,
		);
	});
});
