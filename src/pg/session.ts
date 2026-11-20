/**
 * What both Postgres drivers do on one session, written once: how a read-only transaction
 * begins, how a `COMMIT` that did not commit and a savepoint that could not be kept are
 * refused, how a statement's result is read, and how the `schema` option becomes a
 * `search_path`. The pool driver does it on a
 * connection it checked out, the client driver on the one it was given.
 */

import type { QueryResult, Row } from "../core/contract.ts";
import { TransactionAbortedError } from "../core/errors.ts";
import { quoteIdent } from "../core/sql.ts";
import type { PgDriverOptions, PgQueryResultLike } from "./types.ts";

/**
 * How `transaction(fn, { readOnly: true })` begins: one snapshot for every statement, taken
 * at the first, and no write. `READ COMMITTED`, the default, takes one per statement.
 */
export const BEGIN_READ_ONLY = "begin isolation level repeatable read, read only";

/**
 * What a `COMMIT` that did not commit is refused with. The server sent no error, so there
 * is no `code` and no `cause`: only the command tag said so.
 */
export function notCommitted(command: string): TransactionAbortedError {
	return new TransactionAbortedError(
		`postgres answered COMMIT with ${command}: a statement inside the transaction ` +
			"failed, so nothing was committed; the callback caught that statement's error " +
			"and returned as if it had succeeded",
		"pg",
		{ kind: "aborted" },
	);
}

/**
 * What a savepoint Postgres would not release is refused with: a statement inside it
 * failed and aborted the transaction, and the callback caught that statement's error and
 * resolved. `refusal` is the release's, which says no more than that the transaction was
 * aborted; the statement's own error went to the callback that caught it.
 */
export function notKept(refusal: unknown): TransactionAbortedError {
	return new TransactionAbortedError(
		"a statement inside the savepoint failed, and Postgres aborted the transaction " +
			"with it: the savepoint was rolled back to, not kept. The callback caught that " +
			"statement's error and returned as if it had succeeded",
		"pg",
		{ kind: "aborted" },
		refusal,
	);
}

/**
 * What `query()` answers, from what node-postgres answered. The extended protocol answers
 * one result; several mean a node-postgres that ignored `queryMode` and sent a simple
 * query, which ran every statement, and that is refused after the fact.
 */
export function resultOf<T = Row>(
	result: PgQueryResultLike | PgQueryResultLike[],
): QueryResult<T> {
	if (Array.isArray(result)) {
		throw new TypeError(
			"query() runs one statement, and this text held several (each of them ran): " +
				"a script goes through exec()",
		);
	}
	return {
		rows: result.rows as T[],
		// `rowCount` is null for a statement that affects nothing countable.
		rowCount: result.rowCount ?? result.rows.length,
	};
}

/**
 * The `set search_path` statement `options.schema` asks for, or none. `factory` and the
 * name of its first parameter, `takes`, name the call in a refusal.
 */
export function searchPathOf(
	options: PgDriverOptions | undefined,
	factory: string,
	takes: string,
): string | undefined {
	if (options === undefined) return undefined;
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`${factory}(${takes}, options) takes an object, got ${describe(options)}`,
		);
	}
	const schema: unknown = options.schema;
	if (schema === undefined) return undefined;
	if (typeof schema !== "string" || schema === "") {
		throw new TypeError(
			`${factory}: schema is a non-empty string, got ${describe(schema)}`,
		);
	}
	return `set search_path to ${quoteIdent(schema)}`;
}

/** A short, safe description of a value for an error message. */
export function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "string") return value === "" ? "an empty string" : "a string";
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
