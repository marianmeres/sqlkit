// The client driver's own surface (plan doc 02 #5): one `pg.Client` as a single-connection
// backend, with a schema per case (D20).
//
// Adapter-specific by necessity. The conformance bodies hold `pg-client` to the contract
// like every other adapter; what only one client on Postgres can show:
//
// - **One session.** A statement from outside an open transaction waits for it, where a
//   pool would run it on another connection: the one documented difference from the pool
//   driver. Only Postgres can be asked which transaction ran a statement.
// - **What is sent.** A recording client shows the statements in the order they went: the
//   `search_path` once before the first, `ROLLBACK` and no `COMMIT` for a transaction a
//   failed statement aborted, and the protocol each one went on.
// - **Another process.** An advisory lock taken through a client excludes a pool on the
//   same schema, both ways, and inside a transaction until its end.
// - **The factory.** What it refuses (a pool among them), what it declares, `close()`
//   (D13), and the client's `error` event.
//
// Suite names start with `pg/`: `pnpm run test:pg` selects them by it.

import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { type Driver, SqlError, TransactionAbortedError } from "../../src/mod.ts";
import { createPgClientDriver, type PgStandaloneClientLike } from "../../src/pg/mod.ts";
import { testPgConfig } from "../_env.ts";
import {
	connectedClient,
	createPgClientFixture,
	createPgFixture,
	onFreshSchema,
	type PgFixture,
	sameSchema,
} from "./_fixture.ts";

/** A promise and the function that resolves it: a gate a case opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** An error that is a `TypeError`, whose message matches `pattern`. */
function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

/** What `promise` rejected with; a fulfilment fails the case. */
async function rejection(what: string, promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail(`${what} was not refused`),
		(error: unknown) => error,
	);
}

/**
 * A connected client that records each statement it is sent, as `<protocol>: <text>`:
 * `extended` for one sent on the extended protocol, `simple` for a simple query.
 */
function recording(client: pg.Client): {
	client: PgStandaloneClientLike;
	sent: string[];
} {
	const sent: string[] = [];
	return {
		sent,
		client: {
			query(config) {
				sent.push(`${config.queryMode ?? "simple"}: ${config.text}`);
				return client.query(config);
			},
			end: () => client.end(),
			on: (event, listener) => client.on(event, listener),
			listenerCount: (event) => client.listenerCount(event),
		},
	};
}

interface Recorded {
	driver: Driver;
	schema: string;
	/** Every statement the driver sent, in order. */
	sent: string[];
	/** The client itself, as the host holds it, beside the driver. */
	raw: pg.Client;
}

/** One case: a client driver on a schema of its own holding `t`, recording what it sends. */
async function withRecorded(body: (recorded: Recorded) => Promise<void>): Promise<void> {
	let sent: string[] = [];
	let raw!: pg.Client;
	const fixture = await onFreshSchema(async (schema) => {
		raw = await connectedClient();
		const recorder = recording(raw);
		sent = recorder.sent;
		return createPgClientDriver(recorder.client, { schema });
	});
	try {
		await fixture.driver.query("create table t (id text primary key)");
		sent.length = 0;
		await body({ driver: fixture.driver, schema: fixture.schema, sent, raw });
	} finally {
		await fixture.dispose();
	}
}

/** Rows of `t` whose id is `like` the pattern. `count(*)` is text on Postgres. */
async function countRows(driver: Driver, like: string): Promise<number> {
	const { rows } = await driver.query<{ c: string }>(
		"select count(*) as c from t where id like $1",
		[like],
	);
	return Number(rows[0]?.c ?? -1);
}

describe("pg/client: createPgClientDriver", () => {
	test("refuses what is not a client, a pool, and a schema that is not a non-empty string", async () => {
		for (const notAClient of [undefined, null, {}, { query() {} }, "client"]) {
			assert.throws(
				() =>
					createPgClientDriver(notAClient as unknown as PgStandaloneClientLike),
				typeError(/takes a node-postgres pg\.Client/),
			);
		}
		// Nothing connects: the factory is refused before it touches either.
		const pool = new pg.Pool(testPgConfig());
		const client = new pg.Client(testPgConfig());
		try {
			assert.throws(
				() => createPgClientDriver(pool as unknown as PgStandaloneClientLike),
				typeError(/this is a pool.*createPgDriver takes a pool/),
			);
			for (const schema of ["", 42, null]) {
				assert.throws(
					() =>
						createPgClientDriver(client, {
							schema: schema as unknown as string,
						}),
					typeError(/createPgClientDriver: schema is a non-empty string/),
				);
			}
			assert.throws(
				() => createPgClientDriver(client, "s" as unknown as { schema: string }),
				typeError(/createPgClientDriver\(client, options\) takes an object/),
			);
			assert.throws(
				() => createPgClientDriver(client, { schema: "a\0b" }),
				TypeError,
			);
		} finally {
			await pool.end();
			await client.end();
		}
	});

	test("declares one connection: no concurrent writers, a cross-process lock, no sync tier", async () => {
		const client = new pg.Client(testPgConfig());
		try {
			const driver = createPgClientDriver(client);
			assert.equal(driver.dialect, "pg");
			assert.equal(driver.adapter, "pg-client");
			assert.deepEqual(driver.capabilities, {
				sync: false,
				concurrentWriters: false,
				crossProcessLock: true,
			});
			assert.equal(driver.sync, undefined);
		} finally {
			await client.end();
		}
	});

	test("close() ends the client it was given, once; a statement after it is a SqlError", async () => {
		const raw = await connectedClient();
		let ended = 0;
		const driver = createPgClientDriver({
			query: (config) => raw.query(config),
			end: () => {
				ended += 1;
				return raw.end();
			},
			on: (event, listener) => raw.on(event, listener),
			listenerCount: (event) => raw.listenerCount(event),
		});
		assert.deepEqual((await driver.query("select 1 as one")).rows, [{ one: 1 }]);
		await Promise.all([driver.close(), driver.close()]);
		await driver.close();
		assert.equal(ended, 1);
		const error = await rejection("a query after close()", driver.query("select 1"));
		assert.ok(error instanceof SqlError, String(error));
		assert.equal(error.dialect, "pg");
	});

	test("query() on a node-postgres that ignores queryMode refuses after, naming exec()", async () => {
		// A simple query answers one result per statement, which only a node-postgres that
		// predates `queryMode` would send for a text with no values.
		const result = { rows: [], rowCount: 1, command: "INSERT" };
		const driver = createPgClientDriver({
			query: () => Promise.resolve([result, result] as never),
			end: () => Promise.resolve(),
			on: () => undefined,
			listenerCount: () => 1,
		});
		await assert.rejects(
			driver.query("insert into t values (1); insert into t values (2)"),
			typeError(
				/held several \(each of them ran\): a script goes through exec\(\)/,
			),
		);
	});

	test("a client nobody listens to gets an error listener, and a warning", async () => {
		// Nothing connects: neither client is ever asked for a statement here.
		const alone = new pg.Client(testPgConfig());
		assert.equal(alone.listenerCount("error"), 0);
		const quiet = createPgClientDriver(alone);
		const heard: Error[] = [];
		const hosted = new pg.Client(testPgConfig());
		hosted.on("error", (error) => heard.push(error));
		const loud = createPgClientDriver(hosted);
		try {
			assert.equal(alone.listenerCount("error"), 1);
			// An unlistened `error` would throw from `emit` and end the process. The
			// driver's listener turns it into a warning instead.
			const warned = once(process, "warning");
			alone.emit("error", new Error("connection lost"));
			const [warning] = (await warned) as [Error];
			assert.match(warning.message, /client's connection failed: connection lost/);
			assert.equal((warning.cause as Error).message, "connection lost");

			// When the host listens, the error is the host's to report: no warning.
			let warnings = 0;
			const count = (): void => {
				warnings += 1;
			};
			process.on("warning", count);
			try {
				hosted.emit("error", new Error("host's to handle"));
				await new Promise((resolve) => setImmediate(resolve));
				await new Promise((resolve) => setImmediate(resolve));
			} finally {
				process.off("warning", count);
			}
			assert.deepEqual(
				heard.map((error) => error.message),
				["host's to handle"],
			);
			assert.equal(warnings, 0);
		} finally {
			await quiet.close();
			await loud.close();
		}
	});
});

describe("pg/client: one session", () => {
	test("a statement issued outside an open transaction waits for it rather than joining it", () =>
		withRecorded(async ({ driver, sent }) => {
			const inside = gate();
			const release = gate();
			let inTransaction: string | undefined;
			const open = driver.transaction(async (tx) => {
				await tx.query("insert into t (id) values ('in-tx')");
				const { rows } = await tx.query<{ x: string }>(
					"select txid_current()::text as x",
				);
				inTransaction = rows[0]?.x;
				inside.open();
				await release.opened;
			});
			await inside.opened;

			let answered = false;
			const stranger = driver
				.query<{ x: string; n: string }>(
					"select txid_current()::text as x, (select count(*) from t)::text as n",
				)
				.then((result) => {
					answered = true;
					return result;
				});
			// A pool would have answered by now, from another connection.
			await sleep(100);
			assert.equal(
				answered,
				false,
				"the stranger ran while the transaction was open",
			);
			release.open();
			await open;

			const { rows } = await stranger;
			assert.ok(inTransaction !== undefined);
			assert.notEqual(
				rows[0]?.x,
				inTransaction,
				"the stranger joined the transaction",
			);
			// It ran after the commit, so it sees the committed row.
			assert.equal(rows[0]?.n, "1");
			assert.deepEqual(sent, [
				"simple: begin",
				"extended: insert into t (id) values ('in-tx')",
				"extended: select txid_current()::text as x",
				"simple: commit",
				"extended: select txid_current()::text as x, (select count(*) from t)::text as n",
			]);
		}));

	test("the schema option sets search_path once, before the first statement, outside any transaction", async () => {
		let sent: string[] = [];
		const fixture = await onFreshSchema(async (schema) => {
			const recorder = recording(await connectedClient());
			sent = recorder.sent;
			return createPgClientDriver(recorder.client, { schema });
		});
		try {
			const { driver, schema } = fixture;
			// The first call is a transaction: the search_path goes before its BEGIN.
			await driver.transaction(async (tx) => {
				await tx.exec("create table t (id text)");
			});
			const { rows } = await driver.query<{ s: string }>(
				"select current_schema() as s",
			);
			assert.deepEqual(rows, [{ s: schema }]);
			assert.deepEqual(sent, [
				`simple: set search_path to "${schema}"`,
				"simple: begin",
				"simple: create table t (id text)",
				"simple: commit",
				"extended: select current_schema() as s",
			]);
		} finally {
			await fixture.dispose();
		}
	});
});

describe("pg/client: an aborted transaction", () => {
	test("a failed statement the callback swallowed: ROLLBACK is sent, not COMMIT", () =>
		withRecorded(async ({ driver, sent }) => {
			let failed: unknown;
			const error = await rejection(
				"the transaction",
				driver.transaction(async (tx) => {
					await tx.query("insert into t (id) values ('aborted')");
					failed = await rejection(
						"a missing table",
						tx.query("select * from no_such_table"),
					);
					return "swallowed";
				}),
			);
			assert.ok(error instanceof TransactionAbortedError, String(error));
			assert.equal(error.kind, "aborted");
			assert.equal(error.dialect, "pg");
			assert.equal(error.code, undefined);
			// The core never sent the COMMIT: the failure it saw is the cause.
			assert.equal(error.cause, failed);
			assert.ok(failed instanceof SqlError && failed.code === "42P01");
			assert.deepEqual(sent, [
				"simple: begin",
				"extended: insert into t (id) values ('aborted')",
				"extended: select * from no_such_table",
				"simple: rollback",
			]);
			assert.equal(await countRows(driver, "aborted"), 0);
		}));

	test("a failed statement the callback did not await is waited for, and refuses the commit", () =>
		withRecorded(async ({ driver, sent }) => {
			const error = await rejection(
				"the transaction",
				driver.transaction(async (tx) => {
					await tx.query("insert into t (id) values ('unawaited')");
					void tx.query("select * from no_such_table").catch(() => undefined);
					return "returned";
				}),
			);
			assert.ok(error instanceof TransactionAbortedError, String(error));
			assert.ok((error.cause as SqlError | undefined)?.code === "42P01");
			assert.ok(!sent.includes("simple: commit"), sent.join("\n"));
			assert.equal(sent.at(-1), "simple: rollback");
			assert.equal(await countRows(driver, "unawaited"), 0);
		}));

	test("a transaction a savepoint recovered commits", () =>
		withRecorded(async ({ driver }) => {
			const answer = await driver.transaction(async (tx) => {
				await tx.query("insert into t (id) values ('before')");
				await tx.exec("savepoint recover");
				await assert.rejects(tx.query("insert into t (id) values ('before')"));
				await tx.exec("rollback to savepoint recover");
				await tx.query("insert into t (id) values ('after')");
				return "recovered";
			});
			assert.equal(answer, "recovered");
			assert.equal(await countRows(driver, "before"), 1);
			assert.equal(await countRows(driver, "after"), 1);
		}));

	test("a COMMIT answered with ROLLBACK is refused, for a failure the core could not see", () =>
		withRecorded(async ({ driver, sent, raw }) => {
			// The host fails a statement on the client itself, past the driver: the
			// transaction is aborted, and only the COMMIT's command tag says so.
			const error = await rejection(
				"the transaction",
				driver.transaction(async (tx) => {
					await tx.query("insert into t (id) values ('unseen')");
					await assert.rejects(raw.query("select * from no_such_table"));
				}),
			);
			assert.ok(error instanceof TransactionAbortedError, String(error));
			assert.match(error.message, /answered COMMIT with ROLLBACK/);
			assert.equal(error.cause, undefined);
			assert.equal(sent.at(-1), "simple: commit");
			assert.equal(await countRows(driver, "unseen"), 0);
			// The server ended that transaction itself; the client goes on.
			await driver.transaction(async (tx) => {
				await tx.query("insert into t (id) values ('next')");
			});
			assert.equal(await countRows(driver, "next"), 1);
		}));
});

describe("pg/client: exclusive", () => {
	/** One case, a client driver on a schema of its own, a pool driver on that schema beside it. */
	async function withClientAndPool(
		body: (client: Driver, pool: Driver) => Promise<void>,
	): Promise<void> {
		const fixture: PgFixture = await createPgClientFixture();
		const pool = sameSchema(fixture.schema);
		try {
			await body(fixture.driver, pool);
		} finally {
			try {
				await pool.close();
			} finally {
				await fixture.dispose();
			}
		}
	}

	/** `holder` holds the lock until released; `waiter` must not get in meanwhile. */
	async function assertExcludes(
		holder: (fn: () => Promise<void>) => Promise<unknown>,
		waiter: Driver,
	): Promise<void> {
		const seen: string[] = [];
		const holding = gate();
		const release = gate();
		const first = holder(async () => {
			seen.push("holder in");
			holding.open();
			await release.opened;
			seen.push("holder out");
		});
		await holding.opened;
		const second = waiter.exclusive("lock", async () => {
			seen.push("waiter in");
		});
		// Long enough for a lock that did not exclude to have let the waiter in: it polls
		// every 10 ms at first.
		await sleep(100);
		assert.deepEqual(seen, ["holder in"]);
		release.open();
		await Promise.all([first, second]);
		assert.deepEqual(seen, ["holder in", "holder out", "waiter in"]);
	}

	test("a lock taken through a client driver excludes a pool driver on the same schema", () =>
		withClientAndPool((client, pool) =>
			assertExcludes((fn) => client.exclusive("lock", fn), pool),
		));

	test("a lock taken through a pool driver excludes a client driver on the same schema", () =>
		withClientAndPool((client, pool) =>
			assertExcludes((fn) => pool.exclusive("lock", fn), client),
		));

	test("inside a client's transaction the lock is held until the transaction ends", () =>
		withClientAndPool((client, pool) =>
			assertExcludes(
				(fn) => client.transaction((tx) => tx.exclusive("lock", fn)),
				pool,
			),
		));

	test("a client and a pool on two schemas do not wait for each other", async () => {
		const fixture = await createPgClientFixture();
		const other = await createPgFixture();
		try {
			const release = gate();
			const holding = gate();
			const held = fixture.driver.exclusive("lock", async () => {
				holding.open();
				await release.opened;
			});
			await holding.opened;
			assert.equal(
				await other.driver.exclusive("lock", async () => "free"),
				"free",
			);
			release.open();
			await held;
		} finally {
			try {
				await other.dispose();
			} finally {
				await fixture.dispose();
			}
		}
	});
});
