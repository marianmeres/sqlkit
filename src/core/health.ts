/**
 * Health: whether a database answers, once (`checkHealth`) or on an interval
 * (`createHealthMonitor`).
 *
 *     const monitor = createHealthMonitor(db, {
 *     	onChange: (status, previous) => log(status.healthy ? "db up" : "db down", status.error),
 *     });
 *     await monitor.start(); // after the first check
 *     app.get("/health", () => monitor.last());
 *
 * A check is one `select 1` and never rejects: what the driver rejected with is the
 * status's `error`, a `SqlError` (anything else it rejected with is classified for the
 * driver's dialect, as an adapter would have). The latency is measured on the monotonic
 * clock, so a wall-clock adjustment never makes it negative.
 *
 * A check that has not answered `timeoutMs` (`5_000`) after it was sent is unhealthy: its
 * `error` is a `ConnectionError` of the driver's dialect (so `retryable`) whose message
 * names the timeout, with no `code` and no `cause`. So an outage that hangs rather than
 * refuses, a black-holed packet or a failover, reads as one at the timeout. Its
 * `select 1` is abandoned, not cancelled (a `Driver` has no cancel), and whatever it
 * answers later is dropped. The driver's own timeouts are what end it (a pool's
 * connection timeout, a `statement_timeout`, SQLite's busy timeout); node-postgres's pool
 * waits for a connection without limit unless `connectionTimeoutMillis` is set.
 *
 * The monitor waits for each check: the next starts `intervalMs` after the previous one
 * settled or timed out, so the only check that can be pending beside it is an abandoned
 * one. Its timers never keep a process alive. `onChange` is the hook to log or alert with;
 * there is no logger here. It is called with the first check's status and a `previous` of
 * `null`, and after that only when `healthy` flips. One that throws is caught, and the
 * monitor goes on.
 *
 * Runtime-neutral: imports only the core; the timers are plain `setTimeout`s.
 */

import { classifyPg } from "./classify-pg.ts";
import { classifySqlite } from "./classify-sqlite.ts";
import type { DialectName, Driver } from "./contract.ts";
import { ConnectionError, SqlError, toSqlError } from "./errors.ts";
import { MAX_DELAY_MS } from "./retry.ts";

/** What one check found. */
export interface HealthStatus {
	/** The database answered. */
	healthy: boolean;
	/** How long it took to answer, in milliseconds; `null` when it did not. */
	latencyMs: number | null;
	/** What the check was refused with; `null` when it was healthy. */
	error: SqlError | null;
	/** When the check was sent. */
	checkedAt: Date;
}

/** How long a check waits for its answer by default, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Check once that `db` answers: one `select 1`, timed. Never rejects: a refusal is an
 * unhealthy status, and so is no answer within `timeoutMs`. A `db` that is not a driver,
 * or an option of the wrong type or range, is a `TypeError`, thrown at the call.
 */
export function checkHealth(
	db: Driver,
	options: {
		/**
		 * Milliseconds after which a check that has not answered is unhealthy, its
		 * `select 1` abandoned. `5_000`.
		 */
		timeoutMs?: number;
	} = {},
): Promise<HealthStatus> {
	assertDriver("checkHealth", db);
	assertOptions("checkHealth", options);
	const timeoutMs = readMs(
		"checkHealth",
		"timeoutMs",
		options.timeoutMs,
		DEFAULT_TIMEOUT_MS,
	);
	return check(db, db.dialect, timeoutMs);
}

/**
 * One check, raced against `timeoutMs`. `dialect` is read once, when the driver was
 * accepted. The timer is cleared when the answer comes first, and never keeps a process
 * alive; an answer after it is dropped.
 */
function check(
	db: Driver,
	dialect: DialectName,
	timeoutMs: number,
): Promise<HealthStatus> {
	const checkedAt = new Date();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<HealthStatus>((resolve) => {
		timer = setTimeout(() => {
			resolve({
				healthy: false,
				latencyMs: null,
				error: new ConnectionError(
					`health check timed out after ${timeoutMs} ms`,
					dialect,
					{ kind: "connection" },
				),
				checkedAt,
			});
		}, timeoutMs);
		(timer as { unref?: () => void }).unref?.();
	});
	return Promise.race([ask(db, dialect, checkedAt), timedOut]).finally(() =>
		clearTimeout(timer),
	);
}

/** The `select 1` itself, timed; resolves with what it found, never rejects. */
async function ask(
	db: Driver,
	dialect: DialectName,
	checkedAt: Date,
): Promise<HealthStatus> {
	const start = performance.now();
	try {
		await db.query("select 1");
		const latencyMs = performance.now() - start;
		return { healthy: true, latencyMs, error: null, checkedAt };
	} catch (error) {
		return {
			healthy: false,
			latencyMs: null,
			error: asSqlError(error, dialect),
			checkedAt,
		};
	}
}

/**
 * What a check was refused with, as a `SqlError`: one as it is, anything else classified
 * for the dialect, as an adapter would have.
 */
function asSqlError(error: unknown, dialect: DialectName): SqlError {
	try {
		return toSqlError(error, dialect, dialect === "pg" ? classifyPg : classifySqlite);
	} catch {
		// A thrown value that cannot even be read (a revoked proxy) is still a status: a
		// check that rejected would be an unhandled rejection inside the monitor.
		return new SqlError("unknown error", dialect, { kind: "unknown" }, error);
	}
}

/** A periodic {@link checkHealth}. */
export interface HealthMonitor {
	/**
	 * Start checking: one check now, then one every `intervalMs` after the previous one
	 * settled or timed out. Resolves after the first check; never rejects. Calling it
	 * while the monitor runs answers that run's first check.
	 */
	start(): Promise<void>;
	/**
	 * Stop checking: no next check is left scheduled, and a check still in progress is
	 * not reported (its own timeout, which keeps no process alive, still ends it).
	 * `start()` starts again.
	 */
	stop(): void;
	/** The latest check's status, kept across `stop()`; `null` before the first one. */
	last(): HealthStatus | null;
}

/**
 * A monitor that runs {@link checkHealth} on `db` every `intervalMs` (`30_000`) once
 * started, each check timed out after `timeoutMs` (`5_000`), and calls `onChange` with
 * the first status and on every flip of `healthy`. An option of the wrong type or range
 * is a `TypeError`.
 */
export function createHealthMonitor(
	db: Driver,
	options: {
		/**
		 * Milliseconds between the end of one check (its answer or its timeout) and the
		 * start of the next. `30_000`.
		 */
		intervalMs?: number;
		/**
		 * Milliseconds after which a check that has not answered is reported unhealthy,
		 * its `select 1` abandoned. `5_000`.
		 */
		timeoutMs?: number;
		/**
		 * Called with the first status (`previous` is `null`), then on a flip of
		 * `healthy`, with the check before it as `previous`.
		 */
		onChange?: (status: HealthStatus, previous: HealthStatus | null) => void;
	} = {},
): HealthMonitor {
	assertDriver("createHealthMonitor", db);
	const dialect = db.dialect;
	assertOptions("createHealthMonitor", options);
	const intervalMs = readMs(
		"createHealthMonitor",
		"intervalMs",
		options.intervalMs,
		30_000,
	);
	const timeoutMs = readMs(
		"createHealthMonitor",
		"timeoutMs",
		options.timeoutMs,
		DEFAULT_TIMEOUT_MS,
	);
	const onChange = options.onChange;
	if (onChange !== undefined && typeof onChange !== "function") {
		throw new TypeError(
			`createHealthMonitor: onChange must be a function, got ${describe(onChange)}`,
		);
	}

	let latest: HealthStatus | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// The current run, or `null` when stopped. A check reports only to the run that
	// started it, so one that settles after `stop()` (or after a restart) is dropped.
	let run: { first: Promise<void> } | null = null;

	const report = (status: HealthStatus): void => {
		const previous = latest;
		latest = status;
		if (previous !== null && previous.healthy === status.healthy) return;
		try {
			onChange?.(status, previous);
		} catch {
			// The hook's own failure: the monitor has nobody to hand it to, and goes on.
		}
	};

	const tick = async (current: { first: Promise<void> }): Promise<void> => {
		const status = await check(db, dialect, timeoutMs);
		if (run !== current) return;
		report(status);
		timer = setTimeout(() => {
			timer = undefined;
			void tick(current);
		}, intervalMs);
		(timer as { unref?: () => void }).unref?.();
	};

	return {
		start(): Promise<void> {
			if (run !== null) return run.first;
			const current: { first: Promise<void> } = { first: Promise.resolve() };
			run = current;
			current.first = tick(current);
			return current.first;
		},
		stop(): void {
			run = null;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
		last(): HealthStatus | null {
			return latest;
		},
	};
}

/** Refuses a `db` that is not a driver: no `query` method, or a dialect not known. */
function assertDriver(caller: string, db: unknown): asserts db is Driver {
	const candidate = db as Partial<Driver> | null | undefined;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		typeof candidate.query !== "function" ||
		(candidate.dialect !== "pg" && candidate.dialect !== "sqlite")
	) {
		throw new TypeError(`${caller}(db) takes a Driver, got ${describe(db)}`);
	}
}

/** Refuses an `options` that is not an object. */
function assertOptions(caller: string, options: unknown): asserts options is object {
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`${caller}(db, options) takes an object, got ${describe(options)}`,
		);
	}
}

/**
 * A milliseconds option: a number above 0 and at most `MAX_DELAY_MS` (`setTimeout` fires
 * a longer wait at once), or `fallback` when it is not given.
 */
function readMs(caller: string, name: string, value: unknown, fallback: number): number {
	const ms = value ?? fallback;
	if (typeof ms !== "number" || !(ms > 0 && ms <= MAX_DELAY_MS)) {
		throw new TypeError(
			`${caller}: ${name} must be a number of milliseconds above 0 and at most ${MAX_DELAY_MS}, got ${describe(ms)}`,
		);
	}
	return ms;
}

/** What an option was given, for a message: a number as itself, anything else by type. */
function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	return typeof value;
}
