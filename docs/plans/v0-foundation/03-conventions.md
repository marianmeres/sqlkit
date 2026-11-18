<!--
GENERATED ANALYSIS — @marianmeres/sqlkit v0 foundation
Produced 2026-11-18 by inline research → owner interview (two rounds) → verification.
Claims verified against the prior-art snapshot in tmp/prior-art/ (sources and commits in its
README), including @marianmeres/migrate 2.0.0. Planning artifact; no code was changed.
-->

# Conventions: builders, decoders, retry, migrations

> The conventions layer is what an app or a library reaches for after it has a driver. Four
> of its five pieces are pure functions in the core: they build an `Sql` fragment, decode a
> row, or wrap a call. None of them holds a connection, so each works on the async tier and
> the sync tier alike, and none is a step toward an ORM.
>
> The fifth is migrations. The owner's decision (D06) is to build on
> `@marianmeres/migrate` 2.x rather than write a second runner. That package already has
> the right seam: four hooks. Its own Postgres and SQLite helpers take a raw pool or a raw
> `DatabaseSync`; sqlkit adds one wiring that takes a `Driver`, so the same migrations run
> on every adapter, inside sqlkit's own transactions and locks.

## Summary of recommendations

| # | Recommendation | Value | Effort | Risk |
|---|----------------|-------|--------|------|
| 1 | Statement builders that return `Sql` | high | M | low |
| 2 | Migrate wiring over a `Driver` | high | M | med |
| 3 | Retry and health, driven by `SqlError.retryable` | med | S | low |
| 4 | SQL files as versions (Node only) | med | S | low |
| 5 | Explicit row decoders | med | S | low |

## Findings & recommendations (detailed)

### 1. Statement builders

- **Problem / observation** — The brief asks for a thin table helper with no ORM
  semantics. A repository object would need a connection, a table definition and an
  opinion about rows. A function that returns a fragment needs none of them, and is
  executed by whichever tier the caller is on.
- **Evidence** — The use case as it is written today:
  `tmp/prior-art/steve/_create.ts:28-43` (a helper package turns an object into keys,
  placeholders and values, and the `INSERT` is assembled around them). Values escaped
  into `IN` lists: `tmp/prior-art/steve/pg-quote.ts:7-10`. The `ON CONFLICT` tail the
  prior implementation shares between its dialects:
  `tmp/prior-art/engine/driver/sql.ts:132-143`.
- **Proposed change** — `src/core/build.ts`:

  ```ts
  type TableRef = string | Sql; // a string is quoted as one identifier
  type Returning = "*" | readonly string[];
  type Match = Record<string, unknown>;

  export function insert(
  	table: TableRef,
  	rows: Match | readonly Match[],
  	options?: { returning?: Returning },
  ): Sql;
  export function update(
  	table: TableRef,
  	patch: Match,
  	where: Sql | Match,
  	options?: { returning?: Returning },
  ): Sql;
  export function upsert(
  	table: TableRef,
  	row: Match,
  	options: { conflict: readonly string[]; update?: readonly string[]; returning?: Returning },
  ): Sql;
  export function deleteFrom(
  	table: TableRef,
  	where: Sql | Match,
  	options?: { returning?: Returning },
  ): Sql;
  export function whereEq(match: Match): Sql; // "a" = $1 and "b" is null
  export function and(...parts: readonly Sql[]): Sql;
  export function or(...parts: readonly Sql[]): Sql;
  export function inList(values: readonly unknown[]): Sql; // ($1, $2, $3)
  ```

  Rules, each a test:
  1. A key whose value is `undefined` is left out; `null` binds `NULL` (and is `is null`
     in `whereEq`). A value that is an `Sql` is spliced, so `{ updated_at: raw("now()") }`
     works.
  2. Nothing left to write is a `TypeError`: an empty row, an empty patch, an empty
     `whereEq`, an empty `inList`.
  3. A multi-row `insert` takes its columns from the first row; a row with a different key
     set is a `TypeError`.
  4. `update` and `deleteFrom` require a `where`. `EMPTY` or an empty object is a
     `TypeError`; touching every row is spelled `raw("true")`.
  5. `upsert`'s `update` defaults to every written column not in `conflict`; `update: []`
     renders `do nothing`.
  6. `and()` and `or()` skip `EMPTY` parts and parenthesize each remaining one; with no
     parts left they are `EMPTY`.
  7. Every identifier goes through `ident`; every value is bound.

  The statements are the subset both dialects share (`INSERT … VALUES`, `ON CONFLICT`,
  `RETURNING`). There is deliberately no `select` builder: a query is what the `sql` tag
  is for.
- **Done when** — `test/unit/build.test.ts` passes with a case per rule, asserting the
  rendered text and parameters for both dialects; `test/conformance/builders.ts` passes on
  every registered adapter, executing an insert of two rows, an update with `returning`,
  an upsert that inserts and then updates, a `do nothing` upsert, and a delete.
- **Affected files** — `src/core/build.ts`, `src/mod.ts`, `test/unit/build.test.ts`,
  `test/conformance/builders.ts`, `test/conformance/builders.test.ts`.
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes** — Build on `join`, `ident` and `bind`; do not concatenate
  strings. Later adapter rows inherit the conformance body through the registry.

### 2. Migrate wiring over a `Driver`

- **Problem / observation** — `@marianmeres/migrate` 2.x ships a Postgres helper that
  takes a pool and a SQLite helper that takes a `DatabaseSync`. Neither can serve PGlite
  or a Durable Object, and the SQLite one issues `BEGIN IMMEDIATE` on the raw handle,
  which a sqlkit driver over the same handle does not know about. Workers receive a raw
  client, so they cannot use `sql` fragments or see typed errors.
- **Evidence** — The hooks the helpers are built on:
  `tmp/prior-art/migrate/pg.ts:223-278` (`getActiveVersion`, `setActiveVersion`,
  `wrapRun`, `wrapStep`). The version table: `tmp/prior-art/migrate/pg.ts:137-141`,
  `tmp/prior-art/migrate/sqlite.ts:103-107`. The lock key, derived from
  `migrate:<table>` and the current schema: `tmp/prior-art/migrate/pg.ts:147-151`, `:197`.
  The same derivation in the pool driver's `exclusive`:
  `tmp/prior-art/engine/pg/driver.ts:348-356`. SQLite's run as one write transaction with
  a savepoint per step: `tmp/prior-art/migrate/sqlite.ts:126-157`, `:179-196`. The core
  imports nothing from `node:*` (its two imports are `@marianmeres/item-collection` and
  `@marianmeres/semver`), so it loads in a Worker.
- **Proposed change** — `src/migrate/mod.ts`, exported as `./migrate`;
  `@marianmeres/migrate@^2.0.0` becomes a dependency (D21).

  ```ts
  import { Migrate } from "@marianmeres/migrate";

  export const MIGRATE_TABLE = "__migrate__";
  export interface MigrateContext {
  	/** The driver. Inside a step, its statements are in the step's transaction. */
  	db: Driver;
  }
  export interface MigrateOptions<TExtra extends Record<string, unknown>> {
  	table?: string; // letters, digits, underscores; MIGRATE_TABLE by default
  	context?: TExtra;
  	logger?: (...args: unknown[]) => void;
  }
  export function createMigrate<TExtra extends Record<string, unknown> = Record<never, never>>(
  	db: Driver,
  	options?: MigrateOptions<TExtra>,
  ): Migrate<TExtra & MigrateContext>;
  ```

  The four hooks (D18):

  | Hook | `capabilities.crossProcessLock` | otherwise |
  |------|----------------------------------|-----------|
  | `wrapRun` | `db.exclusive("migrate:" + table, run)`, the table created inside | `db.transaction(run)`, the table created inside |
  | `wrapStep` | `db.transaction(run)` | `db.transaction(run)`, which joins the run's |
  | `getActiveVersion` | newest row; outside a run, `null` when the table does not exist (a read never creates it) | same |
  | `setActiveVersion` | one insert; outside a run it takes the run lock itself | same |

  So on a Postgres pool or client a run holds the advisory lock and commits step by step:
  a failed step is undone and the steps before it stay. Everywhere else the run **is** one
  transaction, because there the transaction is the only lock another process honours: a
  failed step undoes the whole run. That second half differs from the package's own SQLite
  helper, which keeps earlier steps through a savepoint; sqlkit has no savepoints in v0
  (backlog T26).

  The version table's DDL is the package's own, character for character per dialect, and
  the lock name is `migrate:<table>`, which gives the same advisory keys as the package's
  Postgres helper. A database migrated by either can be continued by the other, and the
  two exclude each other while running.
- **Done when** — `test/conformance/migrate.ts` passes on every registered adapter:
  `up()` applies versions in order and records each; a second `up()` does nothing; a
  failing step leaves what the table above says for that adapter's lock mode; `down()` and
  `uninstall()` reverse; `getActiveVersion()` on a fresh database creates no table; an
  invalid table name is a `TypeError`; a worker's statements roll back with its step.
  `test/pg/migrate.test.ts` passes for two drivers on two pools calling `up()` at once,
  each version applied exactly once. `test/pg/migrate-interop.test.ts` and
  `test/sqlite/migrate-interop.test.ts` pass: a database taken to version 1 by the
  package's own helper is taken to version 2 by `createMigrate`, and the reverse.
- **Affected files** — `src/migrate/mod.ts`, `package.json` (`exports["./migrate"]`,
  dependency `@marianmeres/migrate`), `test/conformance/migrate.ts`,
  `test/conformance/migrate.test.ts`, `test/pg/migrate.test.ts`,
  `test/pg/migrate-interop.test.ts`, `test/sqlite/migrate-interop.test.ts`.
- **Effort / Value / Risk** — M / high / med. The risk is the interop promise: it holds
  only while the DDL and the lock name stay identical to the package's.
- **Implementation notes** — Re-entrancy comes for free: `exclusive` is re-entrant and a
  nested `transaction` joins, so `setActiveVersion` inside a step needs no flag. The
  existence check is `select to_regclass($1) is not null` on `pg` and a `sqlite_master`
  lookup on `sqlite`, as in the snapshot files. Workers must not open `begin` themselves
  and cannot run a statement that refuses a transaction (`create index concurrently`,
  `VACUUM`): say so in the module comment, as the package does. Semver ordering has one
  known limit, stated in the package's README: a version registered later below the active
  one is never applied. Repeat that sentence in sqlkit's docs rather than work around it.
  The package's 2.0.0 was published on 2026-11-18: if pnpm's release-age gate refuses it,
  exclude exactly that version in `pnpm-workspace.yaml`.

### 3. Retry and health

- **Problem / observation** — steve and cron each carry the same two files: a retry
  wrapper with a hard-coded list of codes matched against `error.code` or the message
  text, and a health monitor. With typed errors the list becomes one property.
- **Evidence** — `tmp/prior-art/steve/with-db-retry.ts:30-39` (the list), `:60-109` (the
  loop: 3 retries, 100 ms doubling to 5 s); `tmp/prior-art/cron/with-db-retry.ts` is a
  copy. `tmp/prior-art/steve/db-health.ts:15-27` (the status), `:98-140` (the monitor);
  `tmp/prior-art/cron/db-health.ts` is a copy.
- **Proposed change** — `src/core/retry.ts`:

  ```ts
  export interface RetryOptions {
  	retries?: number; // 3
  	initialDelayMs?: number; // 100
  	maxDelayMs?: number; // 5_000
  	factor?: number; // 2
  	/** `error instanceof SqlError && error.retryable` by default. */
  	retryable?: (error: unknown) => boolean;
  	onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  	signal?: AbortSignal; // aborting ends the wait and rejects with the signal's reason
  }
  export function withRetry<T>(fn: (attempt: number) => Promise<T>, options?: RetryOptions): Promise<T>;
  ```

  `src/core/health.ts`:

  ```ts
  export interface HealthStatus {
  	healthy: boolean;
  	latencyMs: number | null;
  	error: SqlError | null;
  	checkedAt: Date;
  }
  export function checkHealth(db: Driver): Promise<HealthStatus>; // select 1; never rejects
  export interface HealthMonitor {
  	start(): Promise<void>; // resolves after the first check
  	stop(): void;
  	last(): HealthStatus | null;
  }
  export function createHealthMonitor(
  	db: Driver,
  	options?: {
  		intervalMs?: number; // 30_000
  		onChange?: (status: HealthStatus, previous: HealthStatus | null) => void;
  	},
  ): HealthMonitor;
  ```

  The monitor's timer never keeps a process alive (`timer.unref?.()`), `onChange` fires
  only when `healthy` flips (and once with the first status, `previous` `null`, D33), and
  an `onChange` that throws is caught.
- **Done when** — `test/unit/retry.test.ts` passes: a retryable error is retried up to
  `retries` and then rethrown; a non-retryable one is rethrown at once; the delays follow
  `factor` and stop at `maxDelayMs`; an aborted signal ends the wait.
  `test/unit/health.test.ts` passes against a stub driver: `checkHealth` never rejects,
  `onChange` fires on a flip and not on a repeat, `stop()` leaves no timer. One
  conformance case per adapter shows `checkHealth` healthy on a live driver.
- **Affected files** — `src/core/retry.ts`, `src/core/health.ts`, `src/mod.ts`,
  `test/unit/retry.test.ts`, `test/unit/health.test.ts`, `test/conformance/driver.ts`.
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — Use injected or mocked timers in the unit tests
  (`node:test`'s `mock.timers`), not real waits. No logger dependency: `onRetry` and
  `onChange` are the hooks. Document that `withRetry` repeats the whole function, so it
  belongs around an idempotent statement or a whole `transaction` call, never around part
  of one.

### 4. SQL files as versions

- **Problem / observation** — The brief asks for plain SQL files. A Worker has no
  filesystem, so file loading cannot be part of the wiring itself; it is a Node-only
  helper beside it. A multi-statement file needs no SQL splitter, because every adapter's
  `exec` takes a script.
- **Evidence** — The package's own example loads one module per version directory and
  treats a version that fails to load as an error (`tmp/prior-art/migrate/README.md`,
  "Versions are applied in order, once").
- **Proposed change** — `src/migrate/files.ts`, exported as `./migrate/files`:

  ```ts
  /** Registers every version found in `dir`; resolves to the versions, in semver order. */
  export function addSqlFiles(
  	migrate: Migrate<MigrateContext>,
  	dir: string,
  ): Promise<string[]>;
  ```

  A version is `<version>.up.sql`, optionally `<version>.down.sql`, optionally with a
  label: `<version>__<label>.up.sql`. The up worker is `({ db }) => db.exec(text)`; with
  no down file the version is registered as irreversible. Refusals, all before anything is
  registered: a `.sql` file that does not match the pattern, a down file with no up file,
  two files for one version and direction, a version semver rejects, and a directory with
  no version in it. Other files are ignored; subdirectories are not read.
- **Done when** — `test/unit/migrate-files.test.ts` passes against temporary directories:
  three versions load in semver order whatever their file order; a labelled file loads; a
  version without a down file is irreversible; each refusal above throws naming the file.
  One case runs loaded files through `createMigrate` on node:sqlite and finds the tables.
- **Affected files** — `src/migrate/files.ts`, `package.json`
  (`exports["./migrate/files"]`), `test/unit/migrate-files.test.ts`.
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — `node:fs/promises` and `node:path` only. The test creates
  its directories under `os.tmpdir()` with `mkdtemp` and removes them.

### 5. Explicit row decoders

- **Problem / observation** — SQLite hands back `1` for a boolean, text for an instant
  and text for JSON, and reports no column type that would say which is which. Postgres
  hands back strings for `int8` and `numeric`. Decoding automatically needs a declared
  schema, which is the first step toward an ORM, so decoding here is explicit and opt-in.
- **Evidence** — The prior implementation decodes exactly one thing by hand, a JSON
  column, in one helper: `tmp/prior-art/engine/driver/sql.ts:152-158`.
- **Proposed change** — `src/core/decode.ts`:

  ```ts
  export type Decoder<T> = (value: unknown, column: string) => T;
  export const decode: {
  	bool: Decoder<boolean | null>;
  	instant: Decoder<Date | null>;
  	json: Decoder<unknown>;
  	bigint: Decoder<bigint | null>;
  	number: Decoder<number | null>;
  };
  export function decodeRow<S extends Record<string, Decoder<unknown>>>(
  	row: Row,
  	spec: S,
  ): Row & { [K in keyof S]: ReturnType<S[K]> };
  export function decodeRows<S extends Record<string, Decoder<unknown>>>(
  	rows: readonly Row[],
  	spec: S,
  ): Array<Row & { [K in keyof S]: ReturnType<S[K]> }>;
  ```

  | Decoder | Accepts | Refuses with `TypeError` |
  |---------|---------|--------------------------|
  | `bool` | `true`/`false`, `1`/`0`, `1n`/`0n`, `"t"`/`"f"`, `"true"`/`"false"`, `"1"`/`"0"` | anything else |
  | `instant` | a `Date`, a string `Date` can parse, a number of epoch milliseconds | an invalid date |
  | `json` | a string (parsed); anything else as it is | a string that is not JSON |
  | `bigint` | a `bigint`, an integer `number`, a string of digits with an optional sign | anything else |
  | `number` | a `number`, a `bigint` or numeric string that is finite and, if an integer, safe | anything else |

  Every decoder passes `null` and `undefined` through as `null`. A column not in the spec
  is left alone. A refusal names the column and the type it found. A column the spec names
  that the row does not have is a `TypeError` (D32).
- **Done when** — `test/unit/decode.test.ts` passes with a case per table cell;
  `test/conformance/decoders.ts` passes on every registered adapter: a boolean, a `Date`
  and a JSON object are written through the parameter rule (doc 01 #2), read back raw, and
  decode to values equal to the originals.
- **Affected files** — `src/core/decode.ts`, `src/mod.ts`, `test/unit/decode.test.ts`,
  `test/conformance/decoders.ts`, `test/conformance/decoders.test.ts`.
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — The conformance table is dialect-specific DDL (`boolean`,
  `timestamptz`, `jsonb` on `pg`; `integer`, `text`, `text` on `sqlite`); the adapter case
  exposes `driver.dialect` for that.

## Open questions / decisions needed

None. D06 and D08 are the owner's; D18 and D19 are the plan author's calls, open to veto
before T13 and T14 run.
