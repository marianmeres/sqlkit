// `withRetry` (plan doc 03 #3): which errors are retried, how many times, how long each wait
// is, and what ends a run early. Timers are `node:test`'s mocked `setTimeout`, so a wait of
// five seconds takes none, and a case can show that a call does not happen a millisecond
// before its time. Imports the root entry point, so it also proves `withRetry` is exported
// there.
import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import {
	DeadlockError,
	type RetryOptions,
	SerializationError,
	SqlError,
	UniqueViolationError,
	withRetry,
} from "../../src/mod.ts";

/** A value past the types, as untyped code would pass it. */
// biome-ignore lint/suspicious/noExplicitAny: the refusal cases call withRetry as untyped code
const loose = (value: unknown): any => value;

/** Every continuation of every settled promise has run: a real `setImmediate`, not mocked. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A promise's outcome, readable synchronously once it settled. */
interface Outcome<T> {
	settled: boolean;
	value?: T;
	error?: unknown;
	rejected: boolean;
}

function track<T>(promise: Promise<T>): Outcome<T> {
	const outcome: Outcome<T> = { settled: false, rejected: false };
	promise.then(
		(value) => {
			Object.assign(outcome, { settled: true, value });
		},
		(error: unknown) => {
			Object.assign(outcome, { settled: true, rejected: true, error });
		},
	);
	return outcome;
}

const serialization = (): SqlError =>
	new SerializationError("could not serialize access", "pg", {
		kind: "serialization",
		code: "40001",
	});

const unique = (): SqlError =>
	new UniqueViolationError("duplicate key", "pg", { kind: "unique", code: "23505" });

/** `fn` for `withRetry` that records each attempt and rejects with what `answer` gives. */
function failing(answer: (attempt: number) => unknown = serialization): {
	calls: number[];
	errors: unknown[];
	fn: (attempt: number) => Promise<never>;
} {
	const calls: number[] = [];
	const errors: unknown[] = [];
	return {
		calls,
		errors,
		fn: async (attempt) => {
			calls.push(attempt);
			const error = answer(attempt);
			errors.push(error);
			throw error;
		},
	};
}

/** Mocked `setTimeout`, so the case drives every wait by hand. */
function mockTimers(t: TestContext): (ms: number) => Promise<void> {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	return async (ms) => {
		t.mock.timers.tick(ms);
		await flush();
	};
}

/**
 * Drive a run that fails every call through each of `delays`, asserting that the next
 * call happens exactly when its wait ends and not a millisecond earlier.
 */
async function walk(
	tick: (ms: number) => Promise<void>,
	calls: number[],
	delays: readonly number[],
): Promise<void> {
	await flush();
	assert.deepEqual(calls, [1]);
	for (const [index, delay] of delays.entries()) {
		if (delay > 0) {
			await tick(delay - 1);
			assert.equal(calls.length, index + 1, `call ${index + 2} came early`);
		}
		await tick(1);
		assert.equal(calls.length, index + 2, `call ${index + 2} did not come`);
	}
}

describe("unit/retry: what is retried", () => {
	test("a first call that resolves is the result; nothing waits", async (t) => {
		mockTimers(t);
		const calls: number[] = [];
		const onRetry = t.mock.fn();
		const value = await withRetry(
			async (attempt) => {
				calls.push(attempt);
				return "ok";
			},
			{ onRetry },
		);
		assert.equal(value, "ok");
		assert.deepEqual(calls, [1]);
		assert.equal(onRetry.mock.callCount(), 0);
	});

	test("a retryable error is retried up to `retries` times, then rethrown", async (t) => {
		const tick = mockTimers(t);
		const { calls, errors, fn } = failing();
		const outcome = track(withRetry(fn, { retries: 2 }));
		await walk(tick, calls, [100, 200]);
		assert.ok(outcome.settled && outcome.rejected, "the run did not end");
		assert.deepEqual(calls, [1, 2, 3]);
		// The last error, untouched: not wrapped, not the first one.
		assert.equal(outcome.error, errors[2]);
		await tick(60_000);
		assert.deepEqual(calls, [1, 2, 3]);
	});

	test("a retry that resolves is the result", async (t) => {
		const tick = mockTimers(t);
		const calls: number[] = [];
		const outcome = track(
			withRetry(async (attempt) => {
				calls.push(attempt);
				if (attempt < 3)
					throw new DeadlockError("deadlock", "pg", { kind: "deadlock" });
				return { rows: [] };
			}),
		);
		await walk(tick, calls, [100, 200]);
		assert.deepEqual(outcome, {
			settled: true,
			rejected: false,
			value: { rows: [] },
		});
	});

	test("every retryable kind is retried by default", async (t) => {
		const tick = mockTimers(t);
		for (const kind of ["serialization", "deadlock", "busy", "connection"] as const) {
			const { calls, fn } = failing(() => new SqlError(kind, "sqlite", { kind }));
			const outcome = track(withRetry(fn, { retries: 1, initialDelayMs: 10 }));
			await walk(tick, calls, [10]);
			assert.ok(outcome.rejected, kind);
			assert.deepEqual(calls, [1, 2], kind);
		}
	});

	test("a non-retryable error is rethrown at once, with no wait", async (t) => {
		mockTimers(t);
		for (const make of [
			unique,
			() => new SqlError("syntax error", "pg", { kind: "unknown", code: "42601" }),
			// A driver's raw error is not a SqlError: the typed error is what is retried,
			// whatever its code says.
			() => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
			() => new TypeError("query() takes a string or a fragment"),
			() => undefined,
		]) {
			const { calls, errors, fn } = failing(make);
			const onRetry = t.mock.fn();
			const outcome = track(withRetry(fn, { onRetry }));
			await flush();
			assert.ok(outcome.settled && outcome.rejected, String(errors[0]));
			assert.equal(outcome.error, errors[0]);
			assert.deepEqual(calls, [1]);
			assert.equal(onRetry.mock.callCount(), 0);
		}
	});

	test("`retries: 0` makes one call", async (t) => {
		mockTimers(t);
		const { calls, errors, fn } = failing();
		await assert.rejects(
			withRetry(fn, { retries: 0 }),
			(error) => error === errors[0],
		);
		assert.deepEqual(calls, [1]);
	});

	test("`retryable` decides instead of the default, and receives the error", async (t) => {
		const tick = mockTimers(t);
		const seen: unknown[] = [];
		const lost = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
		const { calls, fn } = failing((attempt) => (attempt === 1 ? lost : unique()));
		const outcome = track(
			withRetry(fn, {
				retryable: (error) => {
					seen.push(error);
					return error === lost;
				},
			}),
		);
		await walk(tick, calls, [100]);
		assert.ok(outcome.rejected);
		assert.equal(seen[0], lost);
		assert.equal(seen.length, 2);
		assert.ok(outcome.error instanceof UniqueViolationError);
		// And it can refuse what the default retries.
		const refused = failing();
		await assert.rejects(withRetry(refused.fn, { retryable: () => false }));
		assert.deepEqual(refused.calls, [1]);
	});

	test("a synchronous throw from `fn` counts as its rejection", async (t) => {
		const tick = mockTimers(t);
		const calls: number[] = [];
		const outcome = track(
			withRetry(
				loose((attempt: number) => {
					calls.push(attempt);
					if (attempt === 1) throw serialization();
					return Promise.resolve(7);
				}),
			),
		);
		await walk(tick, calls, [100]);
		assert.equal(outcome.value, 7);
	});
});

describe("unit/retry: the waits", () => {
	test("the defaults: 3 retries, 100 ms doubling", async (t) => {
		const tick = mockTimers(t);
		const { calls, fn } = failing();
		const outcome = track(withRetry(fn));
		await walk(tick, calls, [100, 200, 400]);
		assert.ok(outcome.rejected);
		assert.deepEqual(calls, [1, 2, 3, 4]);
	});

	test("the waits follow `factor` and stop at `maxDelayMs`", async (t) => {
		const tick = mockTimers(t);
		const delays: number[] = [];
		const { calls, fn } = failing();
		const outcome = track(
			withRetry(fn, {
				retries: 5,
				initialDelayMs: 100,
				factor: 3,
				maxDelayMs: 1_000,
				onRetry: ({ delayMs }) => delays.push(delayMs),
			}),
		);
		await walk(tick, calls, [100, 300, 900, 1_000, 1_000]);
		assert.deepEqual(delays, [100, 300, 900, 1_000, 1_000]);
		assert.ok(outcome.rejected);
	});

	test("the default ceiling is 5 s", async (t) => {
		const tick = mockTimers(t);
		const { calls, fn } = failing();
		track(withRetry(fn, { retries: 8 }));
		await walk(tick, calls, [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
	});

	test("`factor: 1` waits the same each time; a first wait above the ceiling is cut", async (t) => {
		const tick = mockTimers(t);
		const flat = failing();
		track(withRetry(flat.fn, { initialDelayMs: 250, factor: 1 }));
		await walk(tick, flat.calls, [250, 250, 250]);
		const cut = failing();
		track(withRetry(cut.fn, { retries: 2, initialDelayMs: 900, maxDelayMs: 400 }));
		await walk(tick, cut.calls, [400, 400]);
	});

	test("a wait of 0 still yields to the timer queue", async (t) => {
		const tick = mockTimers(t);
		const { calls, fn } = failing();
		const outcome = track(withRetry(fn, { retries: 2, initialDelayMs: 0 }));
		await walk(tick, calls, [0, 0]);
		assert.ok(outcome.rejected);
	});

	test("`onRetry` is told each failed call, its error and the wait before the next", async (t) => {
		const tick = mockTimers(t);
		const seen: { attempt: number; delayMs: number; error: unknown }[] = [];
		const { calls, errors, fn } = failing();
		track(withRetry(fn, { retries: 2, onRetry: (info) => seen.push(info) }));
		await flush();
		// Told before the wait, not after it.
		assert.deepEqual(seen, [{ attempt: 1, delayMs: 100, error: errors[0] }]);
		await walk(tick, calls, [100, 200]);
		assert.deepEqual(seen, [
			{ attempt: 1, delayMs: 100, error: errors[0] },
			{ attempt: 2, delayMs: 200, error: errors[1] },
		]);
	});
});

describe("unit/retry: what ends a run early", () => {
	test("aborting during a wait ends it with the signal's reason", async (t) => {
		const tick = mockTimers(t);
		const controller = new AbortController();
		const { calls, fn } = failing();
		const outcome = track(withRetry(fn, { signal: controller.signal }));
		await flush();
		await tick(50);
		const reason = new Error("shutting down");
		controller.abort(reason);
		await flush();
		assert.ok(outcome.settled && outcome.rejected, "the wait did not end");
		assert.equal(outcome.error, reason);
		// No call is left behind the cleared wait.
		await tick(60_000);
		assert.deepEqual(calls, [1]);
	});

	test("an aborted signal with no reason given rejects with an AbortError", async (t) => {
		const tick = mockTimers(t);
		const controller = new AbortController();
		const { fn } = failing();
		const outcome = track(withRetry(fn, { signal: controller.signal }));
		await tick(10);
		controller.abort();
		await flush();
		assert.ok(outcome.error instanceof DOMException);
		assert.equal(outcome.error.name, "AbortError");
	});

	test("a signal aborted already makes no call", async (t) => {
		mockTimers(t);
		const reason = new Error("never mind");
		const { calls, fn } = failing();
		await assert.rejects(
			withRetry(fn, { signal: AbortSignal.abort(reason) }),
			(error) => error === reason,
		);
		assert.deepEqual(calls, []);
	});

	test("aborting while a call runs: its value stands, a retry does not happen", async (t) => {
		mockTimers(t);
		const resolved = new AbortController();
		const value = await withRetry(
			async () => {
				resolved.abort(new Error("late"));
				return "done";
			},
			{ signal: resolved.signal },
		);
		assert.equal(value, "done");

		const retried = new AbortController();
		const reason = new Error("stop");
		const onRetry = t.mock.fn();
		const calls: number[] = [];
		await assert.rejects(
			withRetry(
				async (attempt) => {
					calls.push(attempt);
					retried.abort(reason);
					throw serialization();
				},
				{ signal: retried.signal, onRetry },
			),
			(error) => error === reason,
		);
		assert.deepEqual(calls, [1]);
		assert.equal(onRetry.mock.callCount(), 0);

		// An error it would not retry is still the call's own.
		const plain = new AbortController();
		const refusal = unique();
		await assert.rejects(
			withRetry(
				async () => {
					plain.abort(new Error("stop"));
					throw refusal;
				},
				{ signal: plain.signal },
			),
			(error) => error === refusal,
		);
	});

	test("a hook that throws ends the run with what it threw", async (t) => {
		mockTimers(t);
		const hookError = new Error("logger down");
		const onRetryRun = failing();
		await assert.rejects(
			withRetry(onRetryRun.fn, {
				onRetry: () => {
					throw hookError;
				},
			}),
			(error) => error === hookError,
		);
		assert.deepEqual(onRetryRun.calls, [1]);

		const retryableRun = failing();
		await assert.rejects(
			withRetry(retryableRun.fn, {
				retryable: () => {
					throw hookError;
				},
			}),
			(error) => error === hookError,
		);
		assert.deepEqual(retryableRun.calls, [1]);
	});
});

describe("unit/retry: refusals", () => {
	const fn = async (): Promise<number> => 1;

	/** A `TypeError` whose message matches `pattern`. */
	const typeError =
		(pattern: RegExp) =>
		(error: unknown): boolean =>
			error instanceof TypeError && pattern.test(error.message);

	test("`fn` must be a function and `options` an object", async () => {
		for (const value of [undefined, null, "fn", {}]) {
			await assert.rejects(withRetry(loose(value)), typeError(/takes a function/));
		}
		for (const value of [null, "fast", 3, () => ({})]) {
			await assert.rejects(
				withRetry(fn, loose(value)),
				typeError(/takes an object/),
			);
		}
	});

	test("each option of the wrong type or range is a TypeError, before any call", async () => {
		const cases: [Partial<Record<keyof RetryOptions, unknown>>, RegExp][] = [
			[{ retries: -1 }, /retries must be a non-negative integer, got -1/],
			[{ retries: 1.5 }, /retries/],
			[{ retries: Number.NaN }, /retries .* got NaN/],
			[{ retries: Number.POSITIVE_INFINITY }, /retries/],
			[{ retries: "3" }, /retries .* got string/],
			[{ initialDelayMs: -1 }, /initialDelayMs/],
			[{ initialDelayMs: Number.NaN }, /initialDelayMs/],
			[{ initialDelayMs: "100" }, /initialDelayMs/],
			[{ maxDelayMs: Number.POSITIVE_INFINITY }, /maxDelayMs/],
			[{ maxDelayMs: 2 ** 31 }, /maxDelayMs must be .* to 2147483647/],
			[{ factor: 0.5 }, /factor must be a finite number of at least 1/],
			[{ factor: 0 }, /factor/],
			[{ factor: Number.NaN }, /factor/],
			[{ factor: Number.POSITIVE_INFINITY }, /factor/],
			[{ factor: "2" }, /factor/],
			[{ retryable: true }, /retryable must be a function, got boolean/],
			[{ onRetry: "log" }, /onRetry must be a function/],
			[{ signal: {} }, /signal must be an AbortSignal, got object/],
			[{ signal: null }, /signal must be an AbortSignal, got null/],
			[{ signal: "abort" }, /signal/],
		];
		for (const [options, pattern] of cases) {
			const calls: number[] = [];
			await assert.rejects(
				withRetry(async (attempt) => calls.push(attempt), loose(options)),
				typeError(pattern),
				JSON.stringify(options),
			);
			assert.deepEqual(calls, [], JSON.stringify(options));
		}
	});

	test("the edges of each range are accepted", async () => {
		const accepted: RetryOptions[] = [
			{ retries: 0 },
			{ initialDelayMs: 0, maxDelayMs: 0 },
			{ maxDelayMs: 2 ** 31 - 1 },
			{ factor: 1 },
			{ signal: new AbortController().signal },
		];
		for (const options of accepted) {
			assert.equal(await withRetry(fn, options), 1, JSON.stringify(options));
		}
	});
});
