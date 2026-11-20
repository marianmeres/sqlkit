/**
 * Typed errors: what a database refused, said the same way on every adapter.
 *
 * Every adapter rethrows what its driver throws as a `SqlError`, at its boundary, with the
 * driver's error kept untouched as `cause` and its message as the message. The subclass
 * says what happened (`UniqueViolationError`, `DeadlockError`, …), `kind` says the same as
 * a string, and `retryable` says whether running the same work again may succeed.
 *
 * Which driver error is which kind is decided by a classifier, a pure function per dialect
 * (`classify-pg.ts`, `classify-sqlite.ts`); `toSqlError` applies one. An error thrown by
 * callback code is never wrapped, and a programming mistake is a `TypeError`, never a
 * `SqlError`.
 *
 * **Two copies of this module in one process know each other's errors.** An app whose
 * dependencies ask for two `0.x` minors of the package runs two copies of it, so two sets
 * of these classes, and an error one copy's driver threw is no instance of the other's by
 * its prototype chain. So every `SqlError` is marked, on its prototype, with a symbol from
 * `Symbol.for`, as a fragment is (`sql.ts`), and `instanceof` reads the mark: an error
 * another copy built is a `SqlError` here, and an instance of the subclass of its `kind`.
 * A copy from before the mark (0.2.0 and older) has none, and its errors are recognized by
 * nobody but itself.
 *
 * Runtime-neutral: imports only the core's types.
 */

import type { DialectName } from "./contract.ts";

/** What went wrong, as one word. `unknown` is everything no classifier recognized. */
export type SqlErrorKind =
	| "unique"
	| "foreign_key"
	| "not_null"
	| "check"
	| "serialization"
	| "deadlock"
	| "busy"
	| "connection"
	| "read_only"
	| "aborted"
	| "unknown";

/**
 * What a classifier read from a driver error. Every field but `kind` is filled only where
 * the database reported it: the databases tell different things about a constraint, and
 * the types say so rather than pretend.
 */
export interface SqlErrorInfo {
	kind: SqlErrorKind;
	/**
	 * The database's code for the error: the SQLSTATE on `pg` (or Node's code, such as
	 * `ECONNRESET`, for a lost socket), SQLite's extended result code in decimal.
	 */
	code?: string;
	/** The constraint or index refused. */
	constraint?: string;
	/** The table the refused write was on. */
	table?: string;
	/** The columns refused, unqualified. */
	columns?: readonly string[];
}

/** The kinds a retry of the same work may get past. */
const RETRYABLE: ReadonlySet<SqlErrorKind> = new Set([
	"serialization",
	"deadlock",
	"busy",
	"connection",
]);

/** Every kind, so a constructor can refuse one that is not. */
const KINDS: ReadonlySet<string> = new Set<SqlErrorKind>([
	"unique",
	"foreign_key",
	"not_null",
	"check",
	"serialization",
	"deadlock",
	"busy",
	"connection",
	"read_only",
	"aborted",
	"unknown",
]);

/**
 * What marks an error as a `SqlError`, whichever copy of this module built it. JSON cannot
 * carry a symbol, so a parsed object that merely has the fields of one is not one.
 */
const BRAND = Symbol.for("@marianmeres/sqlkit/error");

/** What `instanceof` does for a class that says nothing else: the prototype chain. */
const inChain = Function.prototype[Symbol.hasInstance];

/** Whether `value` carries the mark: a `SqlError` of this copy or of another. */
function isMarked(value: unknown): value is { readonly kind?: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<symbol, unknown>)[BRAND] === true
	);
}

/**
 * A statement or a connection the database refused. Thrown by every adapter in place of
 * its driver's error, which is kept as `cause`. Catch a subclass, or read `kind`.
 *
 * `instanceof` holds across copies of the package: see the module comment.
 */
export class SqlError extends Error {
	/** `value instanceof Class`, for `SqlError` and every class that extends it. */
	static override [Symbol.hasInstance](value: unknown): boolean {
		// biome-ignore lint/complexity/noThisInStatic: the class `instanceof` named, which may be a subclass
		return isInstance(this, value);
	}

	readonly kind: SqlErrorKind;
	readonly dialect: DialectName;
	/** See {@link SqlErrorInfo.code}. */
	readonly code: string | undefined;
	readonly constraint: string | undefined;
	readonly table: string | undefined;
	readonly columns: readonly string[] | undefined;

	/**
	 * `message` is the driver's own message; `cause` is the driver's error. An adapter
	 * calls `toSqlError` rather than this, so that the subclass matches `info.kind`.
	 */
	constructor(
		message: string,
		dialect: DialectName,
		info: SqlErrorInfo,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		if (dialect !== "pg" && dialect !== "sqlite") {
			throw new TypeError(`SqlError: unknown dialect ${JSON.stringify(dialect)}`);
		}
		if (typeof info !== "object" || info === null || !KINDS.has(info.kind)) {
			throw new TypeError(
				`SqlError: unknown kind ${JSON.stringify((info as { kind?: unknown } | null)?.kind)}`,
			);
		}
		this.kind = info.kind;
		this.dialect = dialect;
		this.code = info.code;
		this.constraint = info.constraint;
		this.table = info.table;
		this.columns =
			info.columns === undefined ? undefined : Object.freeze([...info.columns]);
	}

	/** Whether running the same work again may succeed: a serialization failure, a
	 * deadlock, a busy database or a lost connection. */
	get retryable(): boolean {
		return RETRYABLE.has(this.kind);
	}
}

/** `unique`: a duplicate of a unique index or a primary key. */
export class UniqueViolationError extends SqlError {}
/** `foreign_key`: a reference to a row that is not there, or a delete of one referenced. */
export class ForeignKeyViolationError extends SqlError {}
/** `not_null`: `NULL` written to a `NOT NULL` column. */
export class NotNullViolationError extends SqlError {}
/** `check`: a row a `CHECK` constraint refused. */
export class CheckViolationError extends SqlError {}
/** `serialization`: a concurrent transaction won (Postgres `40001`). Retryable. */
export class SerializationError extends SqlError {}
/** `deadlock`: chosen as a deadlock's victim (Postgres `40P01`). Retryable. */
export class DeadlockError extends SqlError {}
/** `busy`: a lock was not granted in time. Retryable. */
export class BusyError extends SqlError {}
/** `connection`: the connection could not be made or was lost. Retryable. */
export class ConnectionError extends SqlError {}
/** `read_only`: a write in a read-only transaction or to a read-only database. */
export class ReadOnlyError extends SqlError {}
/** `aborted`: a statement, or a `COMMIT`, in a transaction a failure already aborted. */
export class TransactionAbortedError extends SqlError {}

/** The class `toSqlError` builds for each kind. */
const CLASS_OF: ReadonlyMap<SqlErrorKind, typeof SqlError> = new Map<
	SqlErrorKind,
	typeof SqlError
>([
	["unique", UniqueViolationError],
	["foreign_key", ForeignKeyViolationError],
	["not_null", NotNullViolationError],
	["check", CheckViolationError],
	["serialization", SerializationError],
	["deadlock", DeadlockError],
	["busy", BusyError],
	["connection", ConnectionError],
	["read_only", ReadOnlyError],
	["aborted", TransactionAbortedError],
	["unknown", SqlError],
]);

/**
 * `value instanceof Class`, for `SqlError` and every class that extends it.
 *
 * An error this copy built is what its prototype chain says, and nothing more. One another
 * copy built is a `SqlError` by its mark, and an instance of the class `toSqlError` builds
 * for its `kind`. It is no instance of a class declared outside this module, and one of a
 * kind this copy does not know is a `SqlError` and nothing narrower.
 */
function isInstance(Class: unknown, value: unknown): boolean {
	if (inChain.call(Class, value)) return true;
	if (inChain.call(SqlError, value) || !isMarked(value)) return false;
	if (Class === SqlError) return true;
	return Class !== undefined && Class === CLASS_OF.get(value.kind as SqlErrorKind);
}

// The mark lives on the one prototype every `SqlError` inherits from: not enumerable, so
// it stays out of `Object.keys` and of an equality check, and not writable.
Object.defineProperty(SqlError.prototype, BRAND, { value: true });

// `name` lives on each prototype, not on each instance: it is set before the constructor
// runs (so the stack's first line says it), stays out of `Object.keys`, and survives a
// minifier that renames the classes.
for (const [Class, name] of [
	[SqlError, "SqlError"],
	[UniqueViolationError, "UniqueViolationError"],
	[ForeignKeyViolationError, "ForeignKeyViolationError"],
	[NotNullViolationError, "NotNullViolationError"],
	[CheckViolationError, "CheckViolationError"],
	[SerializationError, "SerializationError"],
	[DeadlockError, "DeadlockError"],
	[BusyError, "BusyError"],
	[ConnectionError, "ConnectionError"],
	[ReadOnlyError, "ReadOnlyError"],
	[TransactionAbortedError, "TransactionAbortedError"],
] as const) {
	Object.defineProperty(Class.prototype, "name", {
		value: name,
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

/**
 * A driver's error as a `SqlError`: classified by `classify`, built as the subclass of its
 * kind, with the driver's message and the driver's error as `cause`, untouched.
 * Idempotent: a `SqlError` passes through as it is, one another copy of the package built
 * included.
 */
export function toSqlError(
	error: unknown,
	dialect: DialectName,
	classify: (error: unknown) => SqlErrorInfo,
): SqlError {
	if (error instanceof SqlError) return error;
	const info = classify(error);
	const Class = CLASS_OF.get(info.kind) ?? SqlError;
	return new Class(messageOf(error), dialect, info, error);
}

/** The driver's message, or the best text there is for something thrown that is not one. */
function messageOf(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const message: unknown = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	try {
		return String(error);
	} catch {
		// An object with no prototype has no way to become a string.
		return "unknown error";
	}
}
