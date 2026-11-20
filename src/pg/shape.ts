/**
 * The node-postgres shapes (`types.ts`), read at run time: what a pool has, what a client
 * has, and the one thing that tells the two apart. Written once, for the two factories,
 * each of which refuses what is not its own, and for `toPgDriver`, which decides between
 * them.
 *
 * A `pg.Pool` and a `pg.Client` share nearly every method the adapter calls (`query`,
 * `connect`, `end`, `on`), so the methods alone do not say which one an object is. What
 * does is that node-postgres's pool counts its connections, and a client has none to
 * count.
 */

import type { PgPoolLike, PgStandaloneClientLike } from "./types.ts";

/** Whether `value` is an object that has every one of `methods`. */
function has(value: unknown, methods: readonly string[]): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		methods.every(
			(method) => typeof (value as Record<string, unknown>)[method] === "function",
		)
	);
}

/** Whether `value` has what the pool driver calls on a pool. */
export function isPoolShaped(value: unknown): value is PgPoolLike {
	return has(value, ["connect", "end", "on", "listenerCount"]);
}

/** Whether `value` has what the client driver calls on a client. A `pg.Pool` has it too. */
export function isClientShaped(value: unknown): value is PgStandaloneClientLike {
	return has(value, ["query", "end", "on", "listenerCount"]);
}

/** Whether `value` counts its connections, as node-postgres's pool does (`totalCount`). */
export function countsConnections(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { totalCount?: unknown }).totalCount === "number"
	);
}
