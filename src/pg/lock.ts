/**
 * The advisory lock both Postgres drivers take for `exclusive`: the pool driver on a
 * connection it pinned, the client driver on its one connection. One lock name is one
 * pair of `int4` keys, the name's and the schema's, so two schemas are two deployments and
 * never wait for each other, and a pool and a client on the same schema exclude each
 * other.
 *
 * The lock is **polled** (`pg_try_advisory_lock`), never waited for in a statement. A
 * session blocked in `pg_advisory_lock` holds a snapshot, and `CREATE INDEX CONCURRENTLY`
 * in the session that holds the lock waits for every older snapshot to end: the waiter and
 * the holder wait for each other, and Postgres breaks the cycle by killing one with
 * `40P01`. Between polls the waiter holds no snapshot, so the build finishes and the
 * waiter takes its turn.
 *
 * Every statement goes through the `LockStatement` the caller hands in, so that each
 * driver sends it its own way: guarded and on its own turn on a pool, one at a time on a
 * client.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { PgQueryResultLike } from "./types.ts";

/** The first wait between two polls for a lock, in milliseconds. */
const LOCK_POLL_FIRST_MS = 10;
/** The longest wait between two polls: the doubling stops here. */
const LOCK_POLL_MAX_MS = 250;

/** The two `int4` keys of one advisory lock: the name's and the schema's. */
export type LockKey = readonly [number, number];

/** One statement with its values, on the session the lock is taken on. */
export type LockStatement = (
	text: string,
	values: unknown[],
) => Promise<PgQueryResultLike>;

/** The lock's two keys, computed once so a later `search_path` cannot move them. */
export async function lockKeyOf(
	statement: LockStatement,
	name: string,
): Promise<LockKey> {
	const { rows } = await statement(
		"select hashtext($1) as a, hashtext(coalesce(current_schema(), '')) as b",
		[name],
	);
	const row = rows[0];
	if (row === undefined) throw new Error("postgres: hashtext() answered no row");
	return [Number(row.a), Number(row.b)];
}

/**
 * Poll until the lock is taken: `pg_try_advisory_lock` (held by the session until
 * `unlock`) or `pg_try_advisory_xact_lock` (held to the end of the open transaction).
 * Never a blocking `pg_advisory_lock`: see the header for the deadlock that would be.
 * Each poll is one call of `statement`; the wait between two is not.
 */
export async function takeLock(
	statement: LockStatement,
	key: LockKey,
	scope: "session" | "transaction",
): Promise<void> {
	const fn = scope === "session" ? "pg_try_advisory_lock" : "pg_try_advisory_xact_lock";
	let wait = LOCK_POLL_FIRST_MS;
	for (;;) {
		const { rows } = await statement(`select ${fn}($1, $2) as ok`, [...key]);
		if (rows[0]?.ok === true) return;
		await sleep(wait);
		wait = Math.min(wait * 2, LOCK_POLL_MAX_MS);
	}
}

/** Release a session lock `takeLock` took. */
export async function unlock(statement: LockStatement, key: LockKey): Promise<void> {
	await statement("select pg_advisory_unlock($1, $2)", [...key]);
}
