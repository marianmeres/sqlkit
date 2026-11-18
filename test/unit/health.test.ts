// `checkHealth` and `createHealthMonitor` (plan doc 03 #3), against a stub driver whose
// `select 1` a case answers by hand: what a check reports for each way a driver can
// refuse, when the monitor checks and when it calls `onChange`, and that `stop()` leaves
// nothing behind. The monitor's timer is `node:test`'s mocked `setTimeout`, except in the
// one case that shows the real timer does not keep a process alive. A live driver's check
// is the `driver` conformance body's. Imports the root entry point, so it also proves both
// are exported there.
import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import {
	BusyError,
	ConnectionError,
	checkHealth,
	createHealthMonitor,
	type DialectName,
	type Driver,
	type HealthStatus,
	SqlError,
	UniqueViolationError,
} from "../../src/mod.ts";

/** A value past the types, as untyped code would pass it. */
// biome-ignore lint/suspicious/noExplicitAny: the refusal cases call the API as untyped code
const loose = (value: unknown): any => value;

/** Every continuation of every settled promise has run: a real `setImmediate`, not mocked. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** How the stub answers one `query`: resolve, reject with a value, or throw at the call. */
type Answer =
	| { ok: true }
	| { reject: unknown }
	| { throws: unknown }
	| { pending: Promise<unknown> };

interface Stub {
	driver: Driver;
	/** The statements the driver was sent, in order. */
	sent: string[];
	/** What the next query answers; the last one set answers every query after it. */
	answer: Answer;
}

/** A driver that answers `query` as `stub.answer` says and refuses everything else. */
function stubDriver(dialect: DialectName = "pg"): Stub {
	const unused = (): never => {
		throw new Error("the health check calls query() only");
	};
	const stub: Stub = {
		sent: [],
		answer: { ok: true },
		driver: {
			dialect,
			adapter: "stub",
			capabilities: {
				sync: false,
				concurrentWriters: true,
				crossProcessLock: false,
			},
			query: loose((text: string) => {
				stub.sent.push(text);
				const answer = stub.answer;
				if ("throws" in answer) throw answer.throws;
				if ("reject" in answer) return Promise.reject(answer.reject);
				if ("pending" in answer)
					return answer.pending.then(() => ({ rows: [], rowCount: 0 }));
				return Promise.resolve({ rows: [{ "?column?": 1 }], rowCount: 1 });
			}),
			exec: unused,
			transaction: unused,
			exclusive: unused,
			close: unused,
		},
	};
	return stub;
}

/** A promise and the function that resolves it: a check a case lets answer by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

const lost = (): SqlError =>
	new ConnectionError("Connection terminated", "pg", { kind: "connection" });

describe("unit/health: checkHealth", () => {
	test("a driver that answers is healthy, timed, with when it was checked", async () => {
		const { driver, sent } = stubDriver();
		const before = Date.now();
		const status = await checkHealth(driver);
		const after = Date.now();
		assert.deepEqual(sent, ["select 1"]);
		assert.equal(status.healthy, true);
		assert.equal(status.error, null);
		assert.equal(typeof status.latencyMs, "number");
		assert.ok((status.latencyMs ?? -1) >= 0, String(status.latencyMs));
		assert.ok(status.checkedAt instanceof Date);
		assert.ok(
			status.checkedAt.getTime() >= before && status.checkedAt.getTime() <= after,
		);
		assert.deepEqual(Object.keys(status).sort(), [
			"checkedAt",
			"error",
			"healthy",
			"latencyMs",
		]);
	});

	test("a SqlError the driver rejected with is the status's error, as it is", async () => {
		const stub = stubDriver();
		const refusal = lost();
		stub.answer = { reject: refusal };
		const status = await checkHealth(stub.driver);
		assert.equal(status.healthy, false);
		assert.equal(status.latencyMs, null);
		assert.equal(status.error, refusal);
		assert.ok(status.checkedAt instanceof Date);
	});

	test("anything else is classified for the driver's dialect, with the original as cause", async () => {
		const pg = stubDriver("pg");
		const raw = Object.assign(new Error("the database system is shutting down"), {
			code: "08006",
		});
		pg.answer = { reject: raw };
		const pgStatus = await checkHealth(pg.driver);
		assert.ok(pgStatus.error instanceof ConnectionError);
		assert.equal(pgStatus.error.dialect, "pg");
		assert.equal(pgStatus.error.code, "08006");
		assert.equal(pgStatus.error.cause, raw);
		assert.equal(pgStatus.error.message, raw.message);

		const sqlite = stubDriver("sqlite");
		const locked = Object.assign(new Error("database is locked"), { errcode: 5 });
		sqlite.answer = { reject: locked };
		const sqliteStatus = await checkHealth(sqlite.driver);
		assert.ok(sqliteStatus.error instanceof BusyError);
		assert.equal(sqliteStatus.error.dialect, "sqlite");
		assert.equal(sqliteStatus.error.cause, locked);

		// A TypeError (a refused call, a closed driver) is reported too, of kind `unknown`.
		const refused = new TypeError("close() inside a transaction");
		pg.answer = { reject: refused };
		const typeStatus = await checkHealth(pg.driver);
		assert.equal(typeStatus.healthy, false);
		assert.ok(typeStatus.error instanceof SqlError);
		assert.equal(typeStatus.error.kind, "unknown");
		assert.equal(typeStatus.error.cause, refused);
	});

	test("it never rejects, whatever the driver does", async () => {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		const answers: [string, Answer][] = [
			["a synchronous throw", { throws: lost() }],
			["a thrown string", { reject: "down" }],
			["undefined", { reject: undefined }],
			["null", { reject: null }],
			["an object with no prototype", { reject: Object.create(null) }],
			["a revoked proxy", { reject: proxy }],
			["a synchronous throw of a revoked proxy", { throws: proxy }],
		];
		for (const [what, answer] of answers) {
			const stub = stubDriver();
			stub.answer = answer;
			const status = await checkHealth(stub.driver);
			assert.equal(status.healthy, false, what);
			assert.ok(status.error instanceof SqlError, what);
			assert.equal(status.latencyMs, null, what);
		}
	});

	test("a db that is not a driver is a TypeError, thrown at the call", () => {
		for (const db of [
			undefined,
			null,
			"postgres://",
			{},
			{ query: "select 1", dialect: "pg" },
			{ query: () => Promise.resolve(), dialect: "mysql" },
			{ query: () => Promise.resolve() },
		]) {
			assert.throws(
				() => checkHealth(loose(db)),
				(error: unknown) =>
					error instanceof TypeError &&
					/^checkHealth\(db\) takes a Driver/.test(error.message),
				JSON.stringify(db),
			);
		}
	});
});

/** Mocked `setTimeout`; `tick` advances it and lets what the timers started run. */
function mockTimers(t: TestContext): (ms: number) => Promise<void> {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	return async (ms) => {
		t.mock.timers.tick(ms);
		await flush();
	};
}

/** What `onChange` was called with, as `[healthy, previous healthy]` pairs. */
function changes(): {
	seen: [boolean, boolean | null][];
	statuses: [HealthStatus, HealthStatus | null][];
	onChange: (status: HealthStatus, previous: HealthStatus | null) => void;
} {
	const seen: [boolean, boolean | null][] = [];
	const statuses: [HealthStatus, HealthStatus | null][] = [];
	return {
		seen,
		statuses,
		onChange: (status, previous) => {
			seen.push([status.healthy, previous === null ? null : previous.healthy]);
			statuses.push([status, previous]);
		},
	};
}

describe("unit/health: createHealthMonitor", () => {
	test("start() resolves after the first check; last() is null until then", async (t) => {
		mockTimers(t);
		const stub = stubDriver();
		const check = gate();
		stub.answer = { pending: check.opened };
		const monitor = createHealthMonitor(stub.driver);
		assert.equal(monitor.last(), null);
		let started = false;
		const start = monitor.start().then(() => {
			started = true;
		});
		await flush();
		assert.equal(stub.sent.length, 1);
		assert.equal(started, false);
		assert.equal(monitor.last(), null);
		check.open();
		await start;
		assert.equal(monitor.last()?.healthy, true);
		monitor.stop();
	});

	test("onChange: the first status with no previous, then each flip and no repeat", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		const { seen, statuses, onChange } = changes();
		const monitor = createHealthMonitor(stub.driver, { intervalMs: 1_000, onChange });
		await monitor.start();
		assert.deepEqual(seen, [[true, null]]);

		await tick(1_000); // healthy again: a repeat
		assert.equal(stub.sent.length, 2);
		assert.deepEqual(seen, [[true, null]]);

		const repeat = monitor.last();
		stub.answer = { reject: lost() };
		await tick(1_000); // the flip down
		assert.deepEqual(seen, [
			[true, null],
			[false, true],
		]);
		await tick(1_000); // down again: a repeat
		assert.equal(seen.length, 2);

		stub.answer = { ok: true };
		await tick(1_000); // the flip back up
		assert.deepEqual(seen, [
			[true, null],
			[false, true],
			[true, false],
		]);
		assert.equal(stub.sent.length, 5);

		// `previous` is the check before, a repeat that was not reported included, and
		// `last()` the check just made.
		const [down, beforeDown] = statuses[1] ?? [];
		assert.ok(down?.error instanceof ConnectionError);
		assert.equal(beforeDown, repeat);
		assert.notEqual(beforeDown, statuses[0]?.[0]);
		assert.equal(monitor.last(), statuses[2]?.[0]);
		monitor.stop();
	});

	test("an unhealthy first check is reported too", async (t) => {
		mockTimers(t);
		const stub = stubDriver();
		stub.answer = { reject: lost() };
		const { seen, onChange } = changes();
		const monitor = createHealthMonitor(stub.driver, { onChange });
		await monitor.start();
		assert.deepEqual(seen, [[false, null]]);
		assert.equal(monitor.last()?.healthy, false);
		monitor.stop();
	});

	test("the next check starts `intervalMs` after the previous one settled", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		const monitor = createHealthMonitor(stub.driver, { intervalMs: 500 });
		await monitor.start();
		await tick(499);
		assert.equal(stub.sent.length, 1);
		await tick(1);
		assert.equal(stub.sent.length, 2);

		// One check at a time: a slow one delays the next, it is not run beside it.
		const slow = gate();
		stub.answer = { pending: slow.opened };
		await tick(500);
		assert.equal(stub.sent.length, 3);
		await tick(5_000);
		assert.equal(stub.sent.length, 3);
		stub.answer = { ok: true };
		slow.open();
		await flush();
		await tick(499);
		assert.equal(stub.sent.length, 3);
		await tick(1);
		assert.equal(stub.sent.length, 4);
		monitor.stop();
	});

	test("the default interval is 30 s", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		const monitor = createHealthMonitor(stub.driver);
		await monitor.start();
		await tick(29_999);
		assert.equal(stub.sent.length, 1);
		await tick(1);
		assert.equal(stub.sent.length, 2);
		monitor.stop();
	});

	test("stop() leaves no timer: nothing is checked after it", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		const monitor = createHealthMonitor(stub.driver, { intervalMs: 100 });
		await monitor.start();
		await tick(100);
		assert.equal(stub.sent.length, 2);
		monitor.stop();
		await tick(10_000);
		assert.equal(stub.sent.length, 2);
		monitor.stop(); // idempotent
	});

	test("a check in progress at stop() is not reported, and schedules nothing", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		const { seen, onChange } = changes();
		const monitor = createHealthMonitor(stub.driver, { intervalMs: 100, onChange });
		await monitor.start();
		const reported = monitor.last();

		const late = gate();
		stub.answer = { pending: late.opened };
		await tick(100);
		assert.equal(stub.sent.length, 2);
		monitor.stop();
		stub.answer = { reject: lost() };
		late.open();
		await flush();
		assert.equal(monitor.last(), reported);
		assert.deepEqual(seen, [[true, null]]);
		await tick(10_000);
		assert.equal(stub.sent.length, 2);
	});

	test("start() while running answers the same first check; after stop() it starts again", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		const { seen, onChange } = changes();
		const monitor = createHealthMonitor(stub.driver, { intervalMs: 100, onChange });
		const first = monitor.start();
		assert.equal(monitor.start(), first);
		await first;
		assert.equal(stub.sent.length, 1);
		await monitor.start();
		assert.equal(stub.sent.length, 1);

		monitor.stop();
		const kept = monitor.last();
		assert.notEqual(kept, null);
		await monitor.start(); // a fresh check at once
		assert.equal(stub.sent.length, 2);
		// `last()` is kept across a restart, so a status that did not flip is no change.
		assert.deepEqual(seen, [[true, null]]);
		assert.notEqual(monitor.last(), kept);
		await tick(100);
		assert.equal(stub.sent.length, 3);
		monitor.stop();
	});

	test("a check from a stopped run that settles after a restart is dropped", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		const { seen, onChange } = changes();
		const monitor = createHealthMonitor(stub.driver, { intervalMs: 100, onChange });
		const old = gate();
		stub.answer = { pending: old.opened };
		const firstRun = monitor.start();
		monitor.stop();
		stub.answer = { ok: true };
		await monitor.start();
		assert.deepEqual(seen, [[true, null]]);
		const current = monitor.last();

		stub.answer = { reject: lost() };
		old.open(); // the stopped run's check answers now, healthy or not
		await firstRun;
		assert.equal(monitor.last(), current);
		assert.deepEqual(seen, [[true, null]]);
		// And it scheduled nothing of its own: one timer, the current run's.
		await tick(100);
		assert.equal(stub.sent.length, 3);
		monitor.stop();
	});

	test("an onChange that throws is caught, and the monitor goes on", async (t) => {
		const tick = mockTimers(t);
		const stub = stubDriver();
		let calls = 0;
		const monitor = createHealthMonitor(stub.driver, {
			intervalMs: 100,
			onChange: () => {
				calls += 1;
				throw new Error("alerting is down");
			},
		});
		await monitor.start();
		assert.equal(calls, 1);
		assert.equal(monitor.last()?.healthy, true);
		stub.answer = { reject: lost() };
		await tick(100);
		assert.equal(calls, 2);
		assert.equal(monitor.last()?.healthy, false);
		await tick(100);
		assert.equal(stub.sent.length, 3);
		monitor.stop();
	});

	test("the real timer does not keep a process alive", async () => {
		// Mocked timers do not track `unref`, so this case watches the real `setTimeout`.
		const interval = 987_654;
		const handles: ReturnType<typeof setTimeout>[] = [];
		const real = globalThis.setTimeout;
		const spy = ((handler: () => void, ms?: number) => {
			const handle = real(handler, ms);
			if (ms === interval) handles.push(handle);
			return handle;
		}) as typeof setTimeout;
		const stub = stubDriver();
		const monitor = createHealthMonitor(stub.driver, { intervalMs: interval });
		globalThis.setTimeout = spy;
		try {
			await monitor.start();
		} finally {
			globalThis.setTimeout = real;
			monitor.stop();
		}
		assert.equal(handles.length, 1);
		assert.equal(handles[0]?.hasRef(), false);
	});

	test("an option of the wrong type or range is a TypeError", () => {
		const { driver } = stubDriver();
		const cases: [unknown, RegExp][] = [
			[null, /takes an object, got null/],
			["often", /takes an object, got string/],
			[{ intervalMs: 0 }, /intervalMs must be .* above 0 .*, got 0/],
			[{ intervalMs: -5 }, /intervalMs/],
			[{ intervalMs: Number.NaN }, /intervalMs .* got NaN/],
			[{ intervalMs: Number.POSITIVE_INFINITY }, /intervalMs/],
			[{ intervalMs: 2 ** 31 }, /at most 2147483647/],
			[{ intervalMs: "1000" }, /intervalMs .* got string/],
			[{ onChange: "log" }, /onChange must be a function, got string/],
		];
		for (const [options, pattern] of cases) {
			assert.throws(
				() => createHealthMonitor(driver, loose(options)),
				(error: unknown) =>
					error instanceof TypeError && pattern.test(error.message),
				JSON.stringify(options),
			);
		}
		assert.throws(
			() => createHealthMonitor(loose({ dialect: "pg" })),
			/^TypeError: createHealthMonitor\(db\) takes a Driver/,
		);
		// The edges are accepted.
		createHealthMonitor(driver, { intervalMs: 1 });
		createHealthMonitor(driver, { intervalMs: 2 ** 31 - 1 });
	});

	test("a status the monitor reports is what checkHealth returns", async (t) => {
		mockTimers(t);
		const stub = stubDriver("sqlite");
		const duplicate = new UniqueViolationError("UNIQUE constraint failed", "sqlite", {
			kind: "unique",
		});
		stub.answer = { reject: duplicate };
		const monitor = createHealthMonitor(stub.driver);
		await monitor.start();
		const status = monitor.last();
		assert.equal(status?.healthy, false);
		assert.equal(status?.error, duplicate);
		assert.equal(status?.latencyMs, null);
		monitor.stop();
	});
});
