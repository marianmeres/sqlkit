/**
 * The Postgres driver over one client: a `Driver` over a node-postgres `pg.Client` the host
 * connected, or anything shaped like one (`PgStandaloneClientLike`, `types.ts`).
 *
 * A client is one session, so this is a backend of the single-connection driver core, as
 * node:sqlite is: everything takes its turn on the client, and a statement runs inside the
 * open transaction only when that transaction's own callback issued it. **The one
 * difference from the pool driver:** a statement from outside an open transaction waits
 * for that transaction to end, where a pool would run it on another connection at once.
 * The capabilities say so: `{ sync: false, concurrentWriters: false, crossProcessLock:
 * true }`.
 *
 * The backend sends one statement at a time, in the order it was handed them. The core
 * already keeps callers apart; inside a transaction a callback may still issue two
 * statements at once, and node-postgres deprecates a second `query()` on a client that is
 * still running one.
 *
 * - `query()` goes out on the extended protocol (`queryMode: "extended"`), values or not,
 *   so a text of several statements is refused by the server before any of it runs, as on
 *   the pool. `exec()` sends its script as one simple query, any number of statements.
 * - `transaction` is `BEGIN` (`REPEATABLE READ, READ ONLY` for a read-only one), then
 *   `COMMIT`, or `ROLLBACK` when the callback rejected. On Postgres a failed statement
 *   aborts the whole transaction, and the core refuses to commit one that a failure
 *   aborted (`TransactionAbortedError`), so the `ROLLBACK` is sent instead of a `COMMIT`.
 *   The `COMMIT`'s command tag is still checked, as on the pool, for a failure the core
 *   could not see: Postgres answers the `COMMIT` of an aborted transaction with
 *   `ROLLBACK`, and no error.
 * - `savepoint` is `SAVEPOINT`, then `RELEASE`, or `ROLLBACK TO` when the callback
 *   rejected, which is also what lifts the aborted state a failed statement left.
 * - `lock` is the pool driver's advisory lock (`lock.ts`), keyed by the name and the
 *   schema, so a client driver and a pool driver on the same schema exclude each other:
 *   a session lock outside a transaction, released by statement, and a transaction-scoped
 *   one inside, released by the transaction's end. Polled either way.
 * - `options.schema` sets the client's `search_path` once, before the first statement the
 *   driver sends, outside any transaction.
 * - `close()` ends the client (D13). A host that keeps its client does not call it.
 *
 * The client's `error` event (its connection failed while it was idle) is listened to,
 * because a client nobody listens to ends the process on the first one. When the host
 * listens too, the driver stays quiet; when it is the only listener it reports the error
 * through `process.emitWarning`. A client whose connection failed stays failed: every
 * statement after it rejects with a `SqlError`, and the host builds a new client.
 *
 * **Errors are typed by the core (D07):** the backend throws node-postgres's errors as they
 * are, and the core wraps each in a `SqlError` of the kind `classifyPg` reads.
 */

import { classifyPg } from "../core/classify-pg.ts";
import type { Driver, QueryResult, Row } from "../core/contract.ts";
import { savepointBy } from "../core/savepoint.ts";
import type { Connection, SingleConnectionBackend } from "../single/backend.ts";
import { createSingleConnectionDriver } from "../single/driver.ts";
import { type LockStatement, lockKeyOf, takeLock, unlock } from "./lock.ts";
import { BEGIN_READ_ONLY, notCommitted, resultOf, searchPathOf } from "./session.ts";
import { countsConnections, isClientShaped } from "./shape.ts";
import type {
	PgDriverOptions,
	PgQueryConfigLike,
	PgQueryResultLike,
	PgStandaloneClientLike,
} from "./types.ts";

const settled = (): undefined => undefined;

/**
 * A driver over one client the host connected. `close()` ends the client; a host that
 * keeps its client does not call it.
 *
 * With `options.schema`, the client's `search_path` is set to that one schema before the
 * driver's first statement on it.
 *
 * A `pg.Pool` is refused: its `BEGIN`, its statements and its `COMMIT` would each take
 * whichever connection is free. `createPgDriver` is the driver over a pool.
 */
export function createPgClientDriver(
	client: PgStandaloneClientLike,
	options?: PgDriverOptions,
): Driver {
	assertClient(client);
	const setSearchPath = searchPathOf(options, "createPgClientDriver", "client");

	// A client's connection error is emitted on the client, and an `error` nobody
	// listens to ends the process. Quiet when the host listens as well: the report is
	// theirs.
	client.on("error", (error: Error) => {
		if (client.listenerCount("error") > 1) return;
		process.emitWarning(
			new Error(`postgres: the client's connection failed: ${error.message}`, {
				cause: error,
			}),
		);
	});

	return createSingleConnectionDriver(clientBackend(client, setSearchPath));
}

/** One client as a single-connection backend. */
function clientBackend(
	client: PgStandaloneClientLike,
	setSearchPath: string | undefined,
): SingleConnectionBackend {
	/** The tail of what was sent: each statement goes once the one before it settled. */
	let turn: Promise<unknown> = Promise.resolve();
	/** Whether the `search_path` the options ask for is set on the connection yet. */
	let pathSet = setSearchPath === undefined;

	/** Send one statement in its turn, the `search_path` first when it is not set yet. */
	const send = (config: PgQueryConfigLike): Promise<PgQueryResultLike> => {
		const sent = turn.then(async () => {
			if (!pathSet && setSearchPath !== undefined) {
				// A failure leaves it unset: the next statement tries again.
				await client.query({ text: setSearchPath });
				pathSet = true;
			}
			return client.query(config);
		});
		turn = sent.then(settled, settled);
		return sent;
	};

	/** One statement with values, on the extended protocol: what `query()` sends. */
	const statement: LockStatement = (text, values) =>
		send({ text, values, queryMode: "extended" });

	/** Undo the open transaction, keeping whatever failure led here. */
	const rollback = async (): Promise<void> => {
		try {
			await send({ text: "rollback" });
		} catch {
			// A failed ROLLBACK is a symptom, not the cause: the connection is gone, and
			// every statement after it fails the same way.
		}
	};

	const backend: SingleConnectionBackend = {
		dialect: "pg",
		adapter: "pg-client",

		async run(text: string, params: readonly unknown[]): Promise<QueryResult<Row>> {
			return resultOf(await statement(text, [...params]));
		},

		async exec(script: string): Promise<void> {
			// No values: one simple query, which may hold any number of statements.
			await send({ text: script });
		},

		async transaction<T>(
			fn: (inner: Connection) => Promise<T>,
			readOnly: boolean,
		): Promise<T> {
			await send({ text: readOnly ? BEGIN_READ_ONLY : "begin" });
			let result: T;
			try {
				result = await fn(backend);
			} catch (error) {
				await rollback();
				throw error;
			}
			let command: string;
			try {
				({ command } = await send({ text: "commit" }));
			} catch (error) {
				// A COMMIT a deferred constraint refused has ended the transaction already;
				// the ROLLBACK is for a failure that left it open.
				await rollback();
				throw error;
			}
			// The server ended the transaction itself: there is nothing to roll back.
			if (command !== "COMMIT") throw notCommitted(command);
			return result;
		},

		savepoint<T>(fn: () => Promise<T>, _inner: Connection, name: string): Promise<T> {
			// Simple queries, in their turn like every other statement.
			return savepointBy((text) => send({ text }), name, fn);
		},

		async lock(name: string, inTransaction: boolean): Promise<() => Promise<void>> {
			const key = await lockKeyOf(statement, name);
			if (inTransaction) {
				// Held to the end of the transaction: Postgres cannot release it earlier.
				await takeLock(statement, key, "transaction");
				return async () => undefined;
			}
			await takeLock(statement, key, "session");
			return () => unlock(statement, key);
		},

		classify: classifyPg,

		close(): Promise<void> {
			return client.end();
		},
	};
	return backend;
}

/** A client, refused before anything starts when it is not shaped like one, or is a pool. */
function assertClient(client: unknown): asserts client is PgStandaloneClientLike {
	if (!isClientShaped(client)) {
		throw new TypeError(
			"createPgClientDriver(client) takes a node-postgres pg.Client",
		);
	}
	// node-postgres's pool counts its connections; a client has none to count.
	if (countsConnections(client)) {
		throw new TypeError(
			"createPgClientDriver(client) takes one pg.Client, and this is a pool: each of " +
				"its statements may take another connection. createPgDriver takes a pool",
		);
	}
}
