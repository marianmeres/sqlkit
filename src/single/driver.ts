/**
 * The single-connection driver core: a `Driver` over one connection, whatever the
 * database. node:sqlite, one `pg.Client`, PGlite and a Durable Object are backends under it
 * (`backend.ts`); this file owns everything that is not the database.
 *
 * **Everything takes its turn on the one connection.** A statement runs at once only from
 * inside the open transaction's own context (its callback and whatever the callback
 * awaits). From anywhere else it queues behind that transaction, as a top-level
 * `transaction()` does: on a shared connection it would otherwise run *inside* another
 * caller's transaction, see its uncommitted rows, and be rolled back with it. The context
 * is carried by `AsyncLocalStorage`, and it stops counting the moment the callback
 * settles, so a promise that outlives its transaction writes outside it rather than into
 * whichever transaction is open next.
 *
 * The rule's one cost: code that runs during a transaction's callback but issues its
 * statement from a context that does not carry the transaction (a callback handed to an
 * emitter, or to a queue created outside it) waits for the transaction it is part of, and
 * that transaction waits for it. The `tx` handle does not help, since it is this driver:
 * the context decides. The context follows `await`; such a callback is bound from inside
 * the transaction (`AsyncLocalStorage.bind`).
 *
 * A nested `transaction()` joins the open one, as it was opened. The backend is asked for
 * a transaction only at the top level, in the connection's turn.
 *
 * `exclusive()` is an in-process queue per lock name and, where the backend has a lock
 * other processes honour (`backend.lock`), that lock too, taken once the queue lets a
 * caller through. Called inside an open transaction it does not queue: the transaction
 * already excludes every other caller on the connection, and waiting there for a holder
 * whose statements queue behind the transaction would wait for itself. The backend's lock
 * is then taken on the transaction's connection.
 *
 * `query()` and `exec()` always answer with a promise: a refused call and a failing
 * statement reject, as on any other adapter, even when the engine underneath is
 * synchronous.
 *
 * Imports `node:async_hooks` and the core, nothing else.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	assertLockName,
	type Capabilities,
	type Driver,
	type QueryResult,
	type Row,
	readOnlyOf,
	statementOf,
	type TransactionOptions,
} from "../core/contract.ts";
import { normalizeParams } from "../core/params.ts";
import type { Sql } from "../core/sql.ts";
import type { Connection, SingleConnectionBackend } from "./backend.ts";

/**
 * The transaction a context belongs to. One object per transaction, shared by every
 * context that carries it, so closing it once closes it for all of them.
 */
interface OpenTransaction {
	open: boolean;
	/** What the backend handed the transaction's callback: its statements go there. */
	readonly connection: Connection;
}

/**
 * One `exclusive` lock held by a context: its name, whether it is still held, and the
 * lock the context already held when it took this one.
 */
interface Holding {
	readonly name: string;
	open: boolean;
	readonly parent: Holding | undefined;
}

const settled = (): undefined => undefined;

/** A `Driver` over one connection. `close()` ends the connection the backend was given. */
export function createSingleConnectionDriver(backend: SingleConnectionBackend): Driver {
	const dialect = backend.dialect;
	const lock = backend.lock?.bind(backend);
	const capabilities: Capabilities = Object.freeze({
		sync: false,
		concurrentWriters: false,
		crossProcessLock: lock !== undefined,
	});

	const current = new AsyncLocalStorage<OpenTransaction>();
	let queue: Promise<unknown> = Promise.resolve();

	/** Only the open transaction's own context; one whose transaction ended is none. */
	const openTransaction = (): OpenTransaction | undefined => {
		const tx = current.getStore();
		return tx?.open === true ? tx : undefined;
	};

	/** Run `work` after everything queued before it, whatever that answered. */
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const run = queue.then(work, work);
		queue = run.then(settled, settled);
		return run;
	};

	/** `fn(driver)` as a promise: a synchronous throw rejects it. */
	const invoke = <T>(fn: (tx: Driver) => Promise<T>): Promise<T> => {
		try {
			return Promise.resolve(fn(driver));
		} catch (error) {
			return Promise.reject(error);
		}
	};

	const runOn = async (
		connection: Connection,
		text: string,
		params: readonly unknown[],
	): Promise<QueryResult<Row>> => connection.run(text, params);

	const execOn = async (connection: Connection, script: string): Promise<void> => {
		await connection.exec(script);
	};

	const query = <T = Row>(
		statement: Sql | string,
		params?: readonly unknown[],
	): Promise<QueryResult<T>> => {
		let text: string;
		let values: unknown[];
		try {
			const rendered = statementOf(statement, params, dialect);
			text = rendered.text;
			values = normalizeParams(rendered.params, dialect);
		} catch (error) {
			return Promise.reject(error);
		}
		const tx = openTransaction();
		const answer =
			tx === undefined
				? enqueue(() => runOn(backend, text, values))
				: runOn(tx.connection, text, values);
		return answer as Promise<QueryResult<T>>;
	};

	const exec = (script: string): Promise<void> => {
		if (typeof script !== "string") {
			return Promise.reject(
				new TypeError(`exec(script) takes SQL text, got ${describe(script)}`),
			);
		}
		const tx = openTransaction();
		return tx === undefined
			? enqueue(() => execOn(backend, script))
			: execOn(tx.connection, script);
	};

	const transaction = <T>(
		fn: (tx: Driver) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T> => {
		let readOnly: boolean;
		try {
			readOnly = readOnlyOf(options);
			assertCallback(fn, "transaction(fn)");
		} catch (error) {
			return Promise.reject(error);
		}
		// Nested: the open transaction is the transaction, as it was opened.
		if (openTransaction() !== undefined) return invoke(fn);
		return enqueue(() =>
			backend.transaction(async (connection) => {
				const tx: OpenTransaction = { open: true, connection };
				try {
					return await current.run(tx, () => invoke(fn));
				} finally {
					// Before the backend commits or rolls back: whatever the callback left
					// running is a stranger from here on, and queues like one.
					tx.open = false;
				}
			}, readOnly),
		);
	};

	const holding = new AsyncLocalStorage<Holding>();
	/** The tail of each lock name's queue; gone once nobody holds or waits for it. */
	const locks = new Map<string, Promise<unknown>>();

	/** Whether this context already holds the lock `name`. */
	const holds = (name: string): boolean => {
		for (let at = holding.getStore(); at !== undefined; at = at.parent) {
			if (at.open && at.name === name) return true;
		}
		return false;
	};

	/** Run `body` holding `name`, so that a call with that name inside it runs at once. */
	const hold = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
		const lease: Holding = { name, open: true, parent: holding.getStore() };
		try {
			return await holding.run(lease, body);
		} finally {
			// Whatever `body` left running no longer holds it, and queues like a stranger.
			lease.open = false;
		}
	};

	/**
	 * `fn` under the backend's lock, taken and released by `acquire` and through the
	 * release it answers. `fn`'s rejection wins over a failed release.
	 */
	const underLock = async <T>(
		fn: (tx: Driver) => Promise<T>,
		acquire: () => Promise<() => Promise<void>>,
		release: (free: () => Promise<void>) => Promise<void>,
	): Promise<T> => {
		const free = await acquire();
		let result: T;
		try {
			result = await invoke(fn);
		} catch (error) {
			await release(free).catch(settled);
			throw error;
		}
		await release(free);
		return result;
	};

	const exclusive = <T>(name: string, fn: (tx: Driver) => Promise<T>): Promise<T> => {
		try {
			assertLockName(name);
			assertCallback(fn, "exclusive(name, fn)");
		} catch (error) {
			return Promise.reject(error);
		}
		// Re-entrant.
		if (holds(name)) return invoke(fn);
		// Inside an open transaction the transaction is the lock, on this connection.
		if (openTransaction() !== undefined) {
			if (lock === undefined) return invoke(fn);
			return hold(name, () =>
				underLock(
					fn,
					() => lock(name, true),
					(free) => free(),
				),
			);
		}
		const work = (): Promise<T> =>
			hold(name, () =>
				lock === undefined
					? invoke(fn)
					: underLock(
							fn,
							() => enqueue(() => lock(name, false)),
							(free) => enqueue(free),
						),
			);
		const run = (locks.get(name) ?? Promise.resolve()).then(work);
		const tail = run.then(settled, settled);
		locks.set(name, tail);
		void tail.then(() => {
			if (locks.get(name) === tail) locks.delete(name);
		});
		return run;
	};

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		if (openTransaction() !== undefined) {
			// It would queue behind the transaction, which waits for it.
			return Promise.reject(
				new TypeError("close() cannot be called inside a transaction"),
			);
		}
		closing = enqueue(async () => {
			await backend.close();
		});
		return closing;
	};

	const driver: Driver = {
		dialect,
		adapter: backend.adapter,
		capabilities,
		query,
		exec,
		transaction,
		exclusive,
		close,
	};
	return driver;
}

/** A callback, refused before anything starts when it is not a function. */
function assertCallback(fn: unknown, call: string): void {
	if (typeof fn !== "function") {
		throw new TypeError(`${call} takes a function, got ${describe(fn)}`);
	}
}

/** A short, safe description of a value for an error message. */
function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
