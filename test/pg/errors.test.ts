// Typed errors the pool adapter alone can be made to produce (plan doc 01 #4): what takes two
// connections stepped against each other (a serialization failure, a deadlock, a lock not
// granted in time), what only Postgres does to a transaction a statement failed in, and
// what node-postgres says when there is no connection to be had.
//
// Adapter-specific by necessity: a single connection cannot race itself, SQLite neither
// aborts a transaction on a failed statement nor answers its `COMMIT` with `ROLLBACK`, and
// only a pool connects, and times out connecting. The errors every adapter produces are
// in the `errors` conformance body.
//
// Every race is stepped by explicit gates, not timers: each side waits for the other to
// have done its part, and a wait on a lock is observed in `pg_blocking_pids`, not guessed.
// The two timers that remain are Postgres's own, `lock_timeout` and `deadlock_timeout`
// (1 s by default, and only a superuser may lower it): each starts once the wait it ends
// has begun.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import {
	BusyError,
	ConnectionError,
	DeadlockError,
	type Driver,
	SerializationError,
	SqlError,
	TransactionAbortedError,
	withRetry,
} from "../../src/mod.ts";
import { createPgDriver } from "../../src/pg/mod.ts";
import { testPgConfig } from "../_env.ts";
import { createPgFixture, type PgFixture } from "./_fixture.ts";

/** A gate a case opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** How a promise settled, observed from the start, so no rejection goes unhandled. */
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function settle(promise: Promise<unknown>): Promise<Outcome> {
	return promise.then(
		(value): Outcome => ({ ok: true, value }),
		(error: unknown): Outcome => ({ ok: false, error }),
	);
}

/** What `promise` rejected with; a fulfilment fails the case. */
async function rejection(what: string, promise: Promise<unknown>): Promise<unknown> {
	const outcome = await settle(promise);
	if (outcome.ok) return assert.fail(`${what} was not refused`);
	return outcome.error;
}

/** One case, on a schema of its own holding `t` with rows `a` and `b`, on a pool of four. */
async function withFixture(body: (fixture: PgFixture) => Promise<void>): Promise<void> {
	const fixture = await createPgFixture({ max: 4 });
	try {
		await fixture.driver.exec(
			"create table t (id text primary key, n integer not null); " +
				"insert into t (id, n) values ('a', 0), ('b', 0)",
		);
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

async function nOf(driver: Driver, id: string): Promise<number> {
	const { rows } = await driver.query<{ n: number }>("select n from t where id = $1", [
		id,
	]);
	return Number(rows[0]?.n);
}

async function backendPid(handle: Driver): Promise<number> {
	const { rows } = await handle.query<{ pid: number }>(
		"select pg_backend_pid() as pid",
	);
	const pid = rows[0]?.pid;
	assert.ok(typeof pid === "number", "pg_backend_pid() returned nothing");
	return pid;
}

/**
 * Resolves once the backend `pid` is waiting for a lock another backend holds: the barrier
 * between "sent the statement" and "the statement is blocked", read from the server. Gives
 * up after `limitMs`, so a race that went another way fails rather than hangs.
 */
async function blocked(driver: Driver, pid: number, limitMs = 10_000): Promise<void> {
	const until = performance.now() + limitMs;
	for (;;) {
		const { rows } = await driver.query<{ blocked: boolean }>(
			"select cardinality(pg_blocking_pids($1)) > 0 as blocked",
			[pid],
		);
		if (rows[0]?.blocked === true) return;
		if (performance.now() > until) {
			assert.fail(`backend ${pid} never waited for a lock`);
		}
		await sleep(10);
	}
}

/** `error` is a `SqlError` of `Class` and `kind`, with `code`, and the driver's as `cause`. */
function assertTyped(
	error: unknown,
	Class: abstract new (...args: never[]) => SqlError,
	kind: SqlError["kind"],
	code: string | undefined,
): asserts error is SqlError {
	assert.ok(error instanceof Class, `expected a ${Class.name}, got ${String(error)}`);
	assert.ok(error instanceof SqlError);
	assert.equal(error.kind, kind);
	assert.equal(error.dialect, "pg");
	assert.equal(error.code, code);
	const cause = error.cause;
	assert.ok(cause instanceof Error, "cause is not the driver's error");
	assert.ok(!(cause instanceof SqlError));
	assert.equal((cause as Error & { code?: unknown }).code, code);
	assert.equal(error.message, cause.message);
}

/** A port nothing listens on: one a server bound and closed again. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

describe("pg/errors: two connections", () => {
	test("a concurrent update under REPEATABLE READ is a SerializationError, retryable", () =>
		withFixture(async ({ driver }) => {
			const read = gate();
			const committed = gate();
			const loser = settle(
				driver.transaction(async (tx) => {
					try {
						await tx.exec("set transaction isolation level repeatable read");
						// The snapshot is taken here, before the other side's update.
						await tx.query("select n from t where id = 'a'");
					} finally {
						read.open();
					}
					await committed.opened;
					await tx.query("update t set n = n + 1 where id = 'a'");
				}),
			);
			await read.opened;
			await driver.query("update t set n = 10 where id = 'a'");
			committed.open();

			const outcome = await loser;
			assert.ok(!outcome.ok, "the stale update committed");
			assertTyped(outcome.error, SerializationError, "serialization", "40001");
			assert.equal(outcome.error.retryable, true);
			assert.equal(await nOf(driver, "a"), 10);
		}));

	test("a deadlock is a DeadlockError for one side, retryable; the other commits", () =>
		withFixture(async ({ driver }) => {
			const firstHolds = gate();
			const secondHolds = gate();
			let firstPid = -1;
			const first = settle(
				driver.transaction(async (tx) => {
					try {
						firstPid = await backendPid(tx);
						await tx.query("update t set n = 1 where id = 'a'");
					} finally {
						firstHolds.open();
					}
					await secondHolds.opened;
					// Waits for the second, which holds `b`.
					await tx.query("update t set n = 1 where id = 'b'");
				}),
			);
			const second = settle(
				driver.transaction(async (tx) => {
					await firstHolds.opened;
					try {
						await tx.query("update t set n = 2 where id = 'b'");
					} finally {
						secondHolds.open();
					}
					// Only once the first is blocked on `b` does this close the cycle.
					await blocked(driver, firstPid);
					await tx.query("update t set n = 2 where id = 'a'");
				}),
			);

			const outcomes = await Promise.all([first, second]);
			const lost = outcomes.filter((outcome) => !outcome.ok);
			assert.equal(lost.length, 1, "not exactly one side was chosen as the victim");
			const [victim] = lost;
			assert.ok(victim !== undefined && !victim.ok);
			assertTyped(victim.error, DeadlockError, "deadlock", "40P01");
			assert.equal(victim.error.retryable, true);
			// The survivor's two writes are what is left.
			const winner = outcomes[0]?.ok ? 1 : 2;
			assert.deepEqual(
				[await nOf(driver, "a"), await nOf(driver, "b")],
				[winner, winner],
			);
		}));

	test("a lock not granted within lock_timeout is a BusyError, retryable", () =>
		withFixture(async ({ driver }) => {
			const holds = gate();
			const done = gate();
			const holder = settle(
				driver.transaction(async (tx) => {
					try {
						await tx.query("update t set n = 1 where id = 'a'");
					} finally {
						holds.open();
					}
					await done.opened;
				}),
			);
			await holds.opened;
			const error = await rejection(
				"an update of a locked row",
				driver.transaction(async (tx) => {
					await tx.exec("set local lock_timeout = '50ms'");
					await tx.query("update t set n = 2 where id = 'a'");
				}),
			);
			done.open();
			assert.deepEqual(await holder, { ok: true, value: undefined });
			assertTyped(error, BusyError, "busy", "55P03");
			assert.equal(error.retryable, true);
			assert.equal(await nOf(driver, "a"), 1);
		}));
});

describe("pg/errors: an aborted transaction", () => {
	test("a statement after a failed one is a TransactionAbortedError", () =>
		withFixture(async ({ driver }) => {
			let failed: unknown;
			let after: unknown;
			const outcome = await rejection(
				"the transaction",
				driver.transaction(async (tx) => {
					failed = await rejection(
						"a missing table",
						tx.query("select * from no_such_table"),
					);
					after = await rejection("the next statement", tx.query("select 1"));
					throw after;
				}),
			);
			assertTyped(failed, SqlError, "unknown", "42P01");
			assertTyped(after, TransactionAbortedError, "aborted", "25P02");
			assert.equal(after.retryable, false);
			assert.equal(outcome, after, "the callback's error was not the one reported");
		}));

	test("a COMMIT answered with ROLLBACK is a TransactionAbortedError, with no code and no cause", () =>
		withFixture(async ({ driver }) => {
			const error = await rejection(
				"the transaction",
				driver.transaction(async (tx) => {
					await tx.query("update t set n = 1 where id = 'a'");
					await assert.rejects(
						tx.query("select * from no_such_table"),
						SqlError,
					);
				}),
			);
			assert.ok(error instanceof TransactionAbortedError, String(error));
			assert.equal(error.kind, "aborted");
			assert.equal(error.dialect, "pg");
			// The server sent no error: only the command tag said nothing was committed.
			assert.equal(error.code, undefined);
			assert.equal(error.cause, undefined);
			assert.match(error.message, /answered COMMIT with ROLLBACK/);
			assert.equal(await nOf(driver, "a"), 0);
		}));
});

describe("pg/errors: connecting", () => {
	test("a refused connection is a ConnectionError, retryable, wherever it is met", async () => {
		const port = await closedPort();
		const driver = createPgDriver(
			new pg.Pool({
				host: "127.0.0.1",
				port,
				database: "nowhere",
				user: "nobody",
				password: "none",
			}),
		);
		try {
			const calls: [string, () => Promise<unknown>][] = [
				["query", () => driver.query("select 1")],
				["exec", () => driver.exec("select 1")],
				["transaction", () => driver.transaction(async () => assert.fail("ran"))],
				[
					"exclusive",
					() => driver.exclusive("lock", async () => assert.fail("ran")),
				],
			];
			for (const [what, call] of calls) {
				const error = await rejection(what, call());
				assertTyped(error, ConnectionError, "connection", "ECONNREFUSED");
				assert.equal(error.retryable, true, what);
			}
		} finally {
			await driver.close();
		}
	});

	test("a pool that waited out its connection timeout is a ConnectionError, by message", async () => {
		// node-postgres says this one in words only, with no code: the classifier's message
		// pattern is pinned here against the real text.
		const driver = createPgDriver(
			new pg.Pool({ ...testPgConfig(), max: 1, connectionTimeoutMillis: 100 }),
		);
		try {
			// The pool's one connection is made first, and again when the server took longer
			// than the timeout to accept it: the timeout covers connecting too, and a holder
			// that could not connect would never open its gate. What is timed below is the
			// wait for the connection, and nothing else.
			await withRetry(() => driver.query("select 1"));
			const holds = gate();
			const done = gate();
			const holder = settle(
				driver.transaction(async () => {
					holds.open();
					await done.opened;
				}),
			);
			await holds.opened;
			const error = await rejection(
				"a query on a full pool",
				driver.query("select 1"),
			);
			done.open();
			assert.deepEqual(await holder, { ok: true, value: undefined });
			assert.ok(error instanceof ConnectionError, String(error));
			assert.equal(error.kind, "connection");
			assert.equal(error.code, undefined);
			assert.equal(error.retryable, true);
			assert.match(error.message, /timeout exceeded when trying to connect/);
			assert.ok(error.cause instanceof Error);
			assert.equal(error.message, error.cause.message);
		} finally {
			await driver.close();
		}
	});
});
