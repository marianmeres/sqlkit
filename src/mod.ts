/**
 * The root entry point: the runtime-neutral core. It imports nothing from `node:*` and
 * nothing from a driver library, so it loads in a Worker as well as in Node.
 */

export {
	and,
	deleteFrom,
	inList,
	insert,
	type Match,
	or,
	type Returning,
	type TableRef,
	update,
	upsert,
	whereEq,
} from "./core/build.ts";
export { classifyPg } from "./core/classify-pg.ts";
export { classifySqlite } from "./core/classify-sqlite.ts";
export {
	assertLockName,
	type Capabilities,
	type DialectName,
	type Driver,
	type QueryResult,
	type Row,
	readOnlyOf,
	type SyncDriver,
	statementOf,
	type TransactionOptions,
} from "./core/contract.ts";
export { type Decoder, decode, decodeRow, decodeRows } from "./core/decode.ts";
export {
	BusyError,
	CheckViolationError,
	ConnectionError,
	DeadlockError,
	ForeignKeyViolationError,
	NotNullViolationError,
	ReadOnlyError,
	SerializationError,
	SqlError,
	type SqlErrorInfo,
	type SqlErrorKind,
	TransactionAbortedError,
	toSqlError,
	UniqueViolationError,
} from "./core/errors.ts";
export {
	checkHealth,
	createHealthMonitor,
	type HealthMonitor,
	type HealthStatus,
} from "./core/health.ts";
export { normalizeParam, normalizeParams } from "./core/params.ts";
export { type RetryOptions, withRetry } from "./core/retry.ts";
export {
	bind,
	EMPTY,
	ident,
	isSql,
	join,
	json,
	quoteIdent,
	quoteLiteral,
	raw,
	render,
	type Sql,
	sql,
} from "./core/sql.ts";
