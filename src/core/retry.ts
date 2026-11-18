/**
 * Retry with exponential backoff, driven by the typed errors: what is worth running again
 * is `SqlError.retryable` (a serialization failure, a deadlock, a busy database, a lost
 * connection), not a list of codes matched against messages.
 *
 *     const user = await withRetry(() =>
 *     	db.transaction(async (tx) => {
 *     		const { rows } = await tx.query(sql`select … for update`);
 *     		…
 *     	}),
 *     );
 *
 * `withRetry` runs the whole function again, so it belongs around something that is safe
 * to run twice: one idempotent statement, or a whole `transaction` call. Never around part
 * of a transaction: on Postgres a failed statement has aborted the transaction already,
 * and on any database the statements before it are still in it.
 *
 * The delay before retry `n` is `initialDelayMs * factor ** (n - 1)`, at most `maxDelayMs`.
 * `onRetry` is the hook to log with; there is no logger here. An options value of the
 * wrong type is a `TypeError`. A hook (`retryable`, `onRetry`) that throws ends the run
 * with what it threw, untouched, as callback code always does here.
 *
 * Runtime-neutral: imports only the error classes; the wait is a plain `setTimeout`.
 */

import { SqlError } from "./errors.ts";

/** The longest wait `setTimeout` keeps: 2^31 - 1 milliseconds, about 24.8 days. */
export const MAX_DELAY_MS = 2_147_483_647;

/** How {@link withRetry} retries. Every field is optional. */
export interface RetryOptions {
	/** How many times to run the function again after the first call fails. `3`. */
	retries?: number;
	/** The wait before the first retry, in milliseconds. `100`. */
	initialDelayMs?: number;
	/** The longest wait between two calls, in milliseconds. `5_000`. */
	maxDelayMs?: number;
	/** What each wait is multiplied by for the next one; at least 1. `2`. */
	factor?: number;
	/** Whether `error` is worth another call. `error instanceof SqlError && error.retryable` by default. */
	retryable?: (error: unknown) => boolean;
	/**
	 * Called before each wait: `attempt` is the call that failed (1 for the first),
	 * `delayMs` the wait before the next one, `error` what the call rejected with.
	 */
	onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
	/**
	 * Aborting it ends the run with the signal's reason: at once when it is already
	 * aborted, during a wait, or instead of a retry. A call in progress is not
	 * interrupted (hand `fn` the signal for that): its value is still the result, and an
	 * error it would not retry is still rethrown as it is.
	 */
	signal?: AbortSignal;
}

/** `error instanceof SqlError && error.retryable`: the default of {@link RetryOptions.retryable}. */
function isRetryable(error: unknown): boolean {
	return error instanceof SqlError && error.retryable;
}

/**
 * Run `fn`, and run it again while it rejects with a retryable error, up to `retries`
 * times, waiting longer before each call. Resolves with the first call that resolves;
 * rejects with the last error, untouched, once it is not retryable or no retry is left.
 *
 * `fn` receives the number of the call, 1 for the first. See the module comment for what
 * belongs inside it.
 */
export async function withRetry<T>(
	fn: (attempt: number) => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	if (typeof fn !== "function") {
		throw new TypeError(`withRetry(fn) takes a function, got ${describe(fn)}`);
	}
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`withRetry(fn, options) takes an object, got ${describe(options)}`,
		);
	}
	const retries = count("retries", options.retries, 3);
	const initialDelayMs = duration("initialDelayMs", options.initialDelayMs, 100);
	const maxDelayMs = duration("maxDelayMs", options.maxDelayMs, 5_000);
	const factor = options.factor ?? 2;
	if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 1) {
		throw new TypeError(
			`withRetry: factor must be a finite number of at least 1, got ${describe(factor)}`,
		);
	}
	const retryable = hook("retryable", options.retryable) ?? isRetryable;
	const onRetry = hook("onRetry", options.onRetry);
	const signal = options.signal;
	if (
		signal !== undefined &&
		(typeof signal !== "object" ||
			signal === null ||
			typeof signal.addEventListener !== "function")
	) {
		throw new TypeError(
			`withRetry: signal must be an AbortSignal, got ${describe(signal)}`,
		);
	}

	if (signal?.aborted) throw signal.reason;
	let delayMs = Math.min(initialDelayMs, maxDelayMs);
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await fn(attempt);
		} catch (error) {
			if (attempt > retries || !retryable(error)) throw error;
			if (signal?.aborted) throw signal.reason;
			onRetry?.({ attempt, delayMs, error });
			await wait(delayMs, signal);
			delayMs = Math.min(delayMs * factor, maxDelayMs);
		}
	}
}

/** Resolves after `ms`, or rejects with `signal`'s reason once it aborts. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** A count option: a non-negative integer, or `fallback` when it is not given. */
function count(name: string, value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(
			`withRetry: ${name} must be a non-negative integer, got ${describe(value)}`,
		);
	}
	return value;
}

/**
 * A milliseconds option: a number from 0 to `MAX_DELAY_MS`, or `fallback`. A longer wait
 * is refused rather than handed to `setTimeout`, which fires one past its range at once.
 */
function duration(name: string, value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !(value >= 0 && value <= MAX_DELAY_MS)) {
		throw new TypeError(
			`withRetry: ${name} must be a number of milliseconds from 0 to ${MAX_DELAY_MS}, got ${describe(value)}`,
		);
	}
	return value;
}

/** A hook option: a function, or `undefined` when it is not given. */
function hook<F>(name: string, value: F | undefined): F | undefined {
	if (value === undefined || typeof value === "function") return value;
	throw new TypeError(`withRetry: ${name} must be a function, got ${describe(value)}`);
}

/** What an option was given, for a message: a number as itself, anything else by type. */
function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	return typeof value;
}
