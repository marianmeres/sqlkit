/**
 * The Postgres classifier: which `SqlErrorKind` a Postgres driver's error is, and what it
 * reported about the constraint it refused.
 *
 * A pure function over `unknown`. It imports no driver: an error is read by its shape, the
 * fields node-postgres (and any driver that follows its naming) puts on it: the SQLSTATE
 * in `code`, and `constraint`, `table` and `column` where the server sent them. A lost
 * socket arrives with Node's own `code` (`ECONNRESET`, …), and a pool that timed out
 * connecting, or a connection that ended under a query, with a message and no code at all.
 *
 * What Postgres 18 reports: `constraint` and `table` for a unique, foreign-key or check
 * violation; `table` and the column, but no constraint, for a not-null violation.
 *
 * Runtime-neutral: imports only the core's types.
 */

import type { SqlErrorInfo, SqlErrorKind } from "./errors.ts";

/** One SQLSTATE per kind, for the kinds a single code decides. */
const KIND_OF_CODE: ReadonlyMap<string, SqlErrorKind> = new Map<string, SqlErrorKind>([
	["23505", "unique"], // unique_violation
	["23503", "foreign_key"], // foreign_key_violation
	["23502", "not_null"], // not_null_violation
	["23514", "check"], // check_violation
	["40001", "serialization"], // serialization_failure
	["40P01", "deadlock"], // deadlock_detected
	["55P03", "busy"], // lock_not_available
	["25006", "read_only"], // read_only_sql_transaction
	["25P02", "aborted"], // in_failed_sql_transaction
	["57P01", "connection"], // admin_shutdown
	["57P02", "connection"], // crash_shutdown
	["57P03", "connection"], // cannot_connect_now
	["53300", "connection"], // too_many_connections
	// Node's system errors, for a socket that could not be opened or was lost.
	["ECONNREFUSED", "connection"],
	["ECONNRESET", "connection"],
	["ETIMEDOUT", "connection"],
	["ENOTFOUND", "connection"],
	["EPIPE", "connection"],
	["EAI_AGAIN", "connection"],
]);

/** SQLSTATE class 08, `connection_exception`, and every code in it. */
const CONNECTION_CLASS = /^08[0-9A-Z]{3}$/;

/**
 * node-postgres says these in words only, with no `code`: a pool that waited out its
 * `connectionTimeoutMillis`, and a connection that ended, unexpectedly or by a timeout,
 * under a query. Pinned by the classifier's tests, since a reword upstream is otherwise
 * silent.
 */
const CONNECTION_MESSAGE =
	/timeout exceeded when trying to connect|Connection terminated/;

/** Which kind a Postgres driver's error is, and what it reported about the refusal. */
export function classifyPg(error: unknown): SqlErrorInfo {
	if (typeof error !== "object" || error === null) return { kind: "unknown" };
	const fields = error as Record<string, unknown>;
	const code = stringOf(fields.code);
	const info: SqlErrorInfo = { kind: kindOf(code, fields.message) };
	if (code !== undefined) info.code = code;
	const constraint = stringOf(fields.constraint);
	if (constraint !== undefined) info.constraint = constraint;
	const table = stringOf(fields.table);
	if (table !== undefined) info.table = table;
	const column = stringOf(fields.column);
	if (column !== undefined) info.columns = [column];
	return info;
}

function kindOf(code: string | undefined, message: unknown): SqlErrorKind {
	if (code === undefined) {
		return typeof message === "string" && CONNECTION_MESSAGE.test(message)
			? "connection"
			: "unknown";
	}
	return (
		KIND_OF_CODE.get(code) ?? (CONNECTION_CLASS.test(code) ? "connection" : "unknown")
	);
}

/** A non-empty string, or nothing. */
function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
