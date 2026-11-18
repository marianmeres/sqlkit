<!--
GENERATED ANALYSIS — @marianmeres/sqlkit v0 foundation
Produced 2026-11-18 by inline research → owner interview (two rounds) → verification.
Claims verified against the prior-art snapshot in tmp/prior-art/ (sources and commits in its
README) and against node:sqlite on Node 26.13.1. Planning artifact; no code was changed.
-->

# Core: fragments, contract, errors

> The core is the part of sqlkit that has no database in it: the `sql` fragment builder, the
> two interfaces every adapter implements, and the error classes every adapter throws. It
> imports nothing from `node:*` and nothing from a driver library, so it loads in a Worker
> as well as in Node.
>
> Most of it exists already. The prior implementation's fragment builder is ported nearly as
> it is. Its driver interface is ported without the members that belonged to its host (JSON
> access, search, a migrations ledger), and gains a synchronous sibling. Its two duck-typed
> error predicates grow into a full classifier.
>
> The one new idea is the error layer: driver errors are rethrown as `SqlError` subclasses
> at the adapter boundary, with the original kept as `cause`.

## Summary of recommendations

| # | Recommendation | Value | Effort | Risk |
|---|----------------|-------|--------|------|
| 1 | `sql` fragments: port, add `ident` and `json`, render per dialect | high | S | low |
| 2 | The contract: `Driver`, `SyncDriver`, `Capabilities`, parameter rules | high | S | med |
| 3 | `SqlError` classes and the two pure classifiers | high | M | low |
| 4 | Typed errors end to end, pinned by real violations on each adapter | high | M | med |
| 5 | Owner review of the API before more is built on it | high | S | low |

## Findings & recommendations (detailed)

### 1. `sql` fragments

- **Problem / observation** — Three packages build SQL three ways. Two of them number `$n`
  by hand and escape values into the text for `IN` lists. The prior implementation has a
  fragment builder that removes both habits, but it renders through a host-specific
  `Dialect` object and has no fragment for an identifier or a JSON value.
- **Evidence** — `tmp/prior-art/engine/driver/sql.ts:61` (`sql`), `:78-97` (`join`, linear
  on purpose), `:100-111` (`renderSql`). Hand numbering:
  `tmp/prior-art/cron/_find.ts:38-63` (`$${params.length}`); value escaping:
  `tmp/prior-art/steve/pg-quote.ts:7-10`. A JavaScript array bound through node-postgres
  becomes a Postgres array literal, not JSON, so a JSON value has to be stringified by
  hand before it is bound, as `tmp/prior-art/cron/_register.ts:58` does.
- **Proposed change** — `src/core/sql.ts`:

  ```ts
  export interface Sql {
  	readonly kind: "sql";
  	readonly chunks: readonly string[]; // chunks.length === values.length + 1
  	readonly values: readonly unknown[];
  }
  export const EMPTY: Sql;
  export function isSql(value: unknown): value is Sql;
  export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql;
  export function raw(text: string): Sql; // caller owns its safety
  export function bind(value: unknown): Sql; // one bound value
  export function join(parts: readonly Sql[], separator?: string): Sql; // ", " by default
  export function ident(...path: string[]): Sql; // ident("public", "job") → "public"."job"
  export function json(value: unknown): Sql; // one bound value, as JSON text
  export function render(
  	fragment: Sql,
  	dialect: "pg" | "sqlite",
  ): { text: string; params: unknown[] };
  export function quoteIdent(name: string): string;
  export function quoteLiteral(value: string): string;
  ```

  Rules, each a test:
  1. An interpolated `Sql` is spliced; anything else is bound. An interpolated array is
     bound as **one** value, never expanded (`inList` in doc 03 #1 is the expansion).
  2. `render` writes `$1 … $n` for `pg` and `?` for `sqlite`, numbering in order.
  3. `ident` quotes with `"` and doubles an embedded `"` (the same on both dialects). It
     never splits on a dot: a qualified name is two arguments. It throws `TypeError` for no
     segments, an empty segment or a NUL character.
  4. `json(null)` and `json(undefined)` bind SQL `NULL`. Anything else binds
     `JSON.stringify(value)`; a value that stringifies to `undefined` (a function, a
     symbol) throws `TypeError`.
  5. `join([])` is `EMPTY`. `join` stays linear in the total size of its parts and never
     passes a long list as spread arguments.
- **Done when** — `test/unit/sql.test.ts` passes with a case per rule above, plus nesting
  three levels deep and a 30,000-part `join`; `test/unit/core-imports.test.ts` passes,
  proving no file under `src/core/` imports `node:*`, a bare package, or a path outside
  `src/core/`.
- **Affected files** — `src/core/sql.ts`, `src/mod.ts`, `test/unit/sql.test.ts`,
  `test/unit/core-imports.test.ts`.
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes** — Port `sql`, `raw`, `bind`, `join`, `isSql` unchanged from the
  snapshot; rename `renderSql` to `render` and give it the dialect *name*, since the only
  thing it needs is the placeholder style. Do not port `runSql`, `onConflictClause` or
  `parseJsonColumn` (see the snapshot README's map). Port the fragment cases of
  `tmp/prior-art/engine/test/unit/dialect.test.ts`.

### 2. The contract

- **Problem / observation** — The prior driver interface carries seven members, three of
  which (`dialect` object, `search`, `migrate`) served its host. It is async only. D03 adds
  a synchronous tier for engines that are synchronous underneath, and D10/D11 fix the
  shape.
- **Evidence** — `tmp/prior-art/engine/driver/contract.ts:276-319` (the interface and its
  rules), `:227-260` (`TransactionOptions`, `readOnlyOf`), `:338-344` (`assertLockName`).
  The row-or-count guess the SQLite driver makes by keyword:
  `tmp/prior-art/engine/sqlite/driver.ts:86`. On Node 26.13.1 `StatementSync.columns()`
  answers 0 columns for a plain `INSERT` and 1 for `INSERT … RETURNING id` (probed
  2026-11-18), so the guess is no longer needed.
- **Proposed change** — `src/core/contract.ts`:

  ```ts
  export type DialectName = "pg" | "sqlite";
  export type Row = Record<string, unknown>;

  /** `rowCount`: rows returned by a statement that returns rows, rows affected otherwise. */
  export interface QueryResult<T = Row> {
  	rows: T[];
  	rowCount: number;
  }

  export interface TransactionOptions {
  	/** One snapshot, no write. `false` by default. Anything but a boolean is a TypeError. */
  	readonly readOnly?: boolean;
  }

  /** Facts the dialect name does not already tell. */
  export interface Capabilities {
  	/** `driver.sync` exists. */
  	readonly sync: boolean;
  	/** More than one connection: a statement outside a transaction runs beside it. */
  	readonly concurrentWriters: boolean;
  	/** `exclusive()` also excludes other processes on the same database. */
  	readonly crossProcessLock: boolean;
  }

  export interface Driver {
  	readonly dialect: DialectName;
  	readonly adapter: string; // "pg", "pg-client", "node:sqlite", "pglite", "durable-object"
  	readonly capabilities: Capabilities;
  	query<T = Row>(statement: Sql): Promise<QueryResult<T>>;
  	query<T = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  	/** A script: any number of statements, no parameters, no result. */
  	exec(script: string): Promise<void>;
  	transaction<T>(
  		fn: (tx: Driver) => Promise<T>,
  		options?: TransactionOptions,
  	): Promise<T>;
  	exclusive<T>(name: string, fn: (tx: Driver) => Promise<T>): Promise<T>;
  	close(): Promise<void>;
  	readonly sync?: SyncDriver;
  }

  export interface SyncDriver {
  	readonly dialect: DialectName;
  	readonly adapter: string;
  	readonly capabilities: Capabilities;
  	query<T = Row>(statement: Sql): QueryResult<T>;
  	query<T = Row>(text: string, params?: readonly unknown[]): QueryResult<T>;
  	exec(script: string): void;
  	transaction<T>(fn: (tx: SyncDriver) => T, options?: TransactionOptions): T;
  }
  ```

  Also exported: `readOnlyOf`, `assertLockName` (ported), and
  `statementOf(statement, params, dialect): { text, params }`, which every adapter calls
  first: it renders an `Sql`, or passes text and params through, and refuses `params`
  given together with an `Sql`.

  `src/core/params.ts` holds the one parameter rule (D14), applied by every adapter before
  a value reaches a driver:

  | Value | `pg` | `sqlite` |
  |-------|------|----------|
  | `undefined`, `null` | `NULL` | `NULL` |
  | `boolean` | as is | `1` / `0` |
  | `Date` | as is | `toISOString()` |
  | `bigint`, `number`, `string`, `Uint8Array` | as is | as is |
  | plain object | `JSON.stringify` | `JSON.stringify` |
  | array | as is (a Postgres array) | `TypeError`: use `json()` or `inList()` |
  | anything else (function, symbol) | `TypeError` | `TypeError` |

  A raw `Date` handed to node:sqlite binds `NULL` silently, and a raw array is read as a
  named-parameter bag (both probed on Node 26.13.1), which is why the rule is applied
  before the driver and not left to it.

  The contract's rules are the conformance suite's cases (doc 02 #2 writes them):

  | Rule | Statement |
  |------|-----------|
  | R1 | `query` and `exec` always answer with a promise; a failing statement rejects, never throws at the call. |
  | R2 | `rowCount` is as `QueryResult` says, for `SELECT`, a plain write, and a write with `RETURNING`. |
  | R3 | `transaction` commits when `fn` resolves and rolls back when it rejects. On the `pg` dialect, where a failed statement aborts the transaction, a callback that swallowed the failure and resolved gets a rejection, not a silent rollback. (SQLite has no aborted state: the rest of the transaction commits.) |
  | R4 | A nested `transaction` joins the open one, as it was opened. |
  | R5 | A statement belongs to the transaction whose callback issued it, and to no other (D09). One from elsewhere neither sees its uncommitted rows nor goes with its rollback. |
  | R6 | "Inside" ends when the callback settles: a promise that outlives its transaction writes outside it. |
  | R7 | `readOnly` reads one snapshot and refuses a write. |
  | R8 | `exclusive` serializes callers of one name, is re-entrant, lets two names run together, releases on rejection, and inside an open transaction belongs to that transaction. |
  | R9 | `exec` runs every statement of a script and joins the open transaction. |
  | R10 | Parameters follow the table above. Rows are plain objects. |
- **Done when** — `pnpm run typecheck` passes with `src/core/contract.ts` and
  `src/core/params.ts` in place; `test/unit/params.test.ts` passes with a case per table
  cell; `test/unit/contract.test.ts` passes for `readOnlyOf`, `assertLockName` and
  `statementOf`, including the refusal.
- **Affected files** — `src/core/contract.ts`, `src/core/params.ts`, `src/mod.ts`,
  `test/unit/params.test.ts`, `test/unit/contract.test.ts`.
- **Effort / Value / Risk** — S / high / med. The risk is the shape itself: fifteen rows
  build on it. T12 is the owner's look at it before the second half of the sprint.
- **Implementation notes** — Copy the transaction and `exclusive` doc comments from the
  snapshot's `contract.ts`; they are the precise wording of R4–R8. `tx` is the driver
  object itself, as in the prior implementation: the context decides which transaction a
  statement is in, the handle does not. This row lands together with #3 as T03.

### 3. `SqlError` classes and the classifiers

- **Problem / observation** — A caller cannot tell a duplicate from a dropped connection
  without reading driver-specific fields. The prior implementation reads them in two
  places by duck typing; steve and cron match a code list against `error.code` *or the
  message text*. D07 replaces both with typed errors thrown at the adapter boundary.
- **Evidence** — `tmp/prior-art/engine/driver/unique.ts:58-67` and `:70-80` (the two
  shapes), `tmp/prior-art/engine/driver/foreign-key.ts:22-25`,
  `tmp/prior-art/steve/with-db-retry.ts:30-39` and `:83-87`. node:sqlite's shapes, probed
  on Node 26.13.1: every error has `code: "ERR_SQLITE_ERROR"` and a numeric `errcode`;
  `2067` with `UNIQUE constraint failed: t.c`, `1299` with `NOT NULL constraint failed:
  t.c`, `275` with `CHECK constraint failed: n > 0`, `787` with `FOREIGN KEY constraint
  failed` (no table, no column).
- **Proposed change** — `src/core/errors.ts`:

  ```ts
  export type SqlErrorKind =
  	| "unique" | "foreign_key" | "not_null" | "check"
  	| "serialization" | "deadlock" | "busy" | "connection"
  	| "read_only" | "aborted" | "unknown";

  export interface SqlErrorInfo {
  	kind: SqlErrorKind;
  	code?: string; // SQLSTATE on pg; SQLite's extended result code, in decimal
  	constraint?: string;
  	table?: string;
  	columns?: readonly string[];
  }

  export class SqlError extends Error {
  	readonly kind: SqlErrorKind;
  	readonly dialect: DialectName;
  	readonly code: string | undefined;
  	readonly constraint: string | undefined;
  	readonly table: string | undefined;
  	readonly columns: readonly string[] | undefined;
  	get retryable(): boolean; // serialization, deadlock, busy, connection
  }
  export class UniqueViolationError extends SqlError {}
  export class ForeignKeyViolationError extends SqlError {}
  export class NotNullViolationError extends SqlError {}
  export class CheckViolationError extends SqlError {}
  export class SerializationError extends SqlError {}
  export class DeadlockError extends SqlError {}
  export class BusyError extends SqlError {}
  export class ConnectionError extends SqlError {}
  export class ReadOnlyError extends SqlError {}
  export class TransactionAbortedError extends SqlError {}

  /** Idempotent: a `SqlError` passes through. `cause` is the driver's error, untouched. */
  export function toSqlError(
  	error: unknown,
  	dialect: DialectName,
  	classify: (error: unknown) => SqlErrorInfo,
  ): SqlError;
  ```

  `src/core/classify-pg.ts` and `src/core/classify-sqlite.ts` are pure functions over
  `unknown`, importing no driver:

  | Kind | `pg` (`error.code`) | `sqlite` (`error.errcode`) |
  |------|---------------------|-----------------------------|
  | unique | `23505` | `2067`, `1555` |
  | foreign_key | `23503` | `787` |
  | not_null | `23502` | `1299` |
  | check | `23514` | `275` |
  | serialization | `40001` | — |
  | deadlock | `40P01` | — |
  | busy | `55P03` | primary code `5` or `6` (`errcode & 0xff`) |
  | connection | class `08`, `57P01`, `57P02`, `57P03`, `53300`; `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`, `EAI_AGAIN` | — |
  | read_only | `25006` | primary code `8` |
  | aborted | `25P02` | — |
  | unknown | anything else | anything else |

  What each database tells about a constraint differs, and the classes say so in their
  types rather than pretend:

  | Field | `pg` | `sqlite` |
  |-------|------|----------|
  | `constraint` | always, for the four constraint kinds | only for a unique *expression* index (`index 'name'`) and a named `CHECK` |
  | `table` | always | unique and not-null only |
  | `columns` | not-null only (`error.column`) | unique (column form) and not-null |

  The message of a `SqlError` is the driver's message, unchanged.
- **Done when** — `test/unit/classify.test.ts` passes with one fabricated error per table
  cell above (the node:sqlite shapes exactly as recorded under Evidence), a non-object and
  an unrelated `Error` both classified `unknown`, and `toSqlError` shown idempotent and
  keeping `cause`; `test/unit/errors.test.ts` passes for `instanceof` on every class and
  `retryable` on every kind.
- **Affected files** — `src/core/errors.ts`, `src/core/classify-pg.ts`,
  `src/core/classify-sqlite.ts`, `src/mod.ts`, `test/unit/classify.test.ts`,
  `test/unit/errors.test.ts`.
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes** — Erasable TypeScript: declare the fields, assign them in the
  constructor, no parameter properties. One constructor on `SqlError` taking
  `(message, dialect, info, cause)`; a `Map<SqlErrorKind, typeof SqlError>` picks the
  subclass in `toSqlError`. Parse SQLite's subject from the message the way
  `tmp/prior-art/engine/driver/unique.ts:70-80` does. node-postgres reports a lost socket
  with a Node `code` (`ECONNRESET`), and a pool timeout with a message and no code: match
  `/timeout exceeded when trying to connect|Connection terminated/` as `connection` and
  pin both strings in the test, since an upstream reword is otherwise silent.

### 4. Typed errors end to end

- **Problem / observation** — #3 classifies fabricated shapes. Nothing yet proves the
  shapes are the ones real databases produce, or that an adapter wraps at every place a
  driver can throw.
- **Evidence** — The prior implementation pins its two shapes the same way, by raising a
  real violation on each database (`tmp/prior-art/engine/driver/foreign-key.ts:16-18`).
  `COMMIT` answered with `ROLLBACK`: `tmp/prior-art/engine/pg/driver.ts:294-298`, thrown
  there as a plain `Error`.
- **Proposed change** — Each adapter passes every error from the driver through
  `toSqlError` with its own classifier: from `query`, `exec`, connecting, and the
  statements that open and end a transaction. An error thrown by callback code passes
  through untouched. A `COMMIT` the server answered with `ROLLBACK` rejects with
  `TransactionAbortedError`. A new runner-agnostic body `test/conformance/errors.ts` raises
  real failures on every adapter:
  1. unique, foreign key, not-null and check violations: the class, `kind`, and the fields
     the table in #3 promises for that dialect;
  2. a write inside `transaction(fn, { readOnly: true })`: `ReadOnlyError`;
  3. an error thrown by the callback: the same object comes out, unwrapped;
  4. `error.cause` is the driver's own error.

  Adapter-specific suites cover what only one database can produce: on Postgres a
  serialization failure, a deadlock, a refused connection (a port a test server bound and
  closed, so nothing listens) and an aborted transaction; on node:sqlite a busy database
  (two handles on one temp file, `timeout: 0`).
- **Done when** — `test/conformance/errors.ts` passes on every registered adapter;
  `test/pg/errors.test.ts` and `test/sqlite/errors.test.ts` pass with the cases named
  above; no `catch` in `src/` reads `.code`, `.errcode` or `.constraint` outside the two
  classifier files (`test/unit/core-imports.test.ts` gains that check).
- **Affected files** — `src/single/driver.ts`, `src/sqlite/mod.ts`, `src/pg/pool.ts`,
  `test/conformance/errors.ts`, `test/conformance/errors.test.ts`, `test/pg/errors.test.ts`,
  `test/sqlite/errors.test.ts`, `test/unit/core-imports.test.ts`.
- **Effort / Value / Risk** — M / high / med. Producing a deadlock and a serialization
  failure on demand needs two connections stepped in order; keep those tests
  deterministic with explicit barriers, not timers.
- **Implementation notes** — Wrap in one place per adapter (a `guard(fn)` around every
  driver call), not at each call site. Later adapters (T15, T16, T19) inherit this body
  through the adapter registry and must pass it; the snapshot's
  `tmp/prior-art/engine/test/pg/transaction-pinning.test.ts:136` is the aborted-transaction
  case to port.

### 5. Owner review of the API

- **Problem / observation** — Rows T13–T20 build on the contract, the tier rules and the
  Durable Objects findings. A shape the owner would change is cheapest to change here.
- **Proposed change** — A `🔒` row. The owner writes a small script against node:sqlite
  and Postgres using `sql`, `query`, `transaction`, `exclusive`, `db.sync`, the builders
  and the decoders, reads `DO-FINDINGS.md`, and either ticks the row or edits the
  decisions log (D09–D24) and the affected sections first.
- **Done when** — The owner sets T12 to `✅`, with any change recorded as a new `D##`.
- **Effort / Value / Risk** — S / high / low.

## Open questions / decisions needed

None. D09–D17 are the plan author's calls, each open to veto before its row runs; they are
listed in `PROGRESS.md`.
