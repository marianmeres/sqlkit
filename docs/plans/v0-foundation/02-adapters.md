<!--
GENERATED ANALYSIS — @marianmeres/sqlkit v0 foundation
Produced 2026-11-18 by inline research → owner interview (two rounds) → verification.
Claims verified against the prior-art snapshot in tmp/prior-art/ (sources and commits in its
README), node:sqlite on Node 26.13.1, and the Cloudflare Durable Objects SQLite storage API
reference as published on 2026-11-18. Planning artifact; no code was changed.
-->

# Adapters

> Five adapters, two shapes. Postgres through a pool is its own implementation, because a
> pool is many connections and a transaction has to pin one. Everything else (node:sqlite,
> a single `pg.Client`, PGlite, a Durable Object) is **one connection**, and one connection
> has one rule: everything takes its turn, and a statement runs inside the open transaction
> only when that transaction's own callback issued it.
>
> That rule is written once, in a single-connection driver core, and the four adapters are
> small backends under it. The prior implementation has the rule already, inside its SQLite
> driver; this plan lifts it out.
>
> Durable Objects is the most constrained target and nobody is waiting for it (D04), so it
> is handled in two steps: a spike in real workerd right after the contract exists, whose
> job is to stop the sprint if an assumption is wrong, and the adapter itself as the last
> code row.

Source layout this document assumes (D21):

```
src/mod.ts              "."                core only, no node:*
src/core/               fragments, contract, params, errors, classifiers, builders, decoders, retry, health
src/single/             the single-connection driver core (imports node:async_hooks)
src/sqlite/mod.ts       "./sqlite"         node:sqlite
src/pg/mod.ts           "./pg"             node-postgres: a Pool, or one Client
src/pglite/mod.ts       "./pglite"         PGlite
src/do/mod.ts           "./do"             Durable Objects SQLite storage
src/migrate/mod.ts      "./migrate"        wiring for @marianmeres/migrate
src/migrate/files.ts    "./migrate/files"  SQL files → versions (node:fs)
```

Every adapter takes a client the host built (D12) and declares its shape structurally, so
no adapter imports a driver library, not even its types.

## Summary of recommendations

| # | Recommendation | Value | Effort | Risk |
|---|----------------|-------|--------|------|
| 1 | Durable Objects spike: a workerd harness under `node:test`, six assumptions checked | high | M | med |
| 2 | Single-connection driver core, the node:sqlite adapter, the conformance harness | high | L | med |
| 3 | The sync tier on node:sqlite, and what the two tiers refuse of each other | high | M | med |
| 4 | Postgres pool adapter | high | M | low |
| 5 | One `pg.Client` as a driver | med | S | low |
| 6 | PGlite adapter | med | M | med |
| 7 | Durable Objects adapter | med | L | high |

## Findings & recommendations (detailed)

### 1. Durable Objects spike

- **Problem / observation** — The contract has to hold on Durable Objects, and the design
  rests on behaviour the reference documents only in part. `node:test` cannot run inside
  workerd, so the harness that will later run the conformance suite there has to exist
  before anything depends on it.
- **Evidence** — The storage API reference states: `sql.exec()` is synchronous and "cannot
  execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`";
  `transactionSync(callback)` requires a callback that is not `async` and rolls back when
  it throws; inside the async `ctx.storage.transaction()` closure, SQL run through
  `ctx.storage.sql.exec()` is part of the transaction; a multi-statement `exec` applies
  bindings to the last statement only. It does not state how bindings of type boolean,
  `Date` or `bigint` behave, whether `transactionSync` nests, or what an error object
  carries. `rowsWritten` is a billing counter, so it may not equal rows affected.
- **Proposed change** — A harness and a probe, both kept:
  - `test/do/_workerd.ts`: bundles a worker entry with esbuild (externals `node:*`,
    `cloudflare:*`), starts Miniflare with one SQLite-backed Durable Object class, the
    `nodejs_compat` flag and an OS-assigned port, and exposes
    `call(name, payload): Promise<unknown>` that dispatches a request to the object.
  - `test/do/worker/probe.ts`: the Durable Object, one handler per check below.
  - `test/do/probe.test.ts`: asserts each assumption and records each probe's answer.
  - `docs/plans/v0-foundation/DO-FINDINGS.md`: one entry per probe, `F01`…, with the
    observed behaviour and the workerd version it was observed on.

  **Assumptions** (the design depends on each; a contradiction is `blocked`, not a
  workaround):

  | # | Assumption |
  |---|------------|
  | A1 | `ctx.storage.sql.exec()` runs synchronously, and a multi-statement script with no bindings executes every statement. |
  | A2 | `ctx.storage.transactionSync(fn)` returns `fn`'s value and rolls back `sql.exec` writes when `fn` throws. |
  | A3 | `await ctx.storage.transaction(async () => …)` includes `sql.exec` writes, survives an `await` inside the closure, and rolls the writes back when the closure rejects. |
  | A4 | `BEGIN` and `SAVEPOINT` through `sql.exec` are refused, so a transaction can only be callback-shaped. |
  | A5 | `AsyncLocalStorage` from `node:async_hooks` works under `nodejs_compat`, and its store is still there after an `await` inside `ctx.storage.transaction()`. |
  | A6 | `node:assert/strict` is importable under `nodejs_compat`. |

  **Probes** (recorded, never a reason to block):

  | # | Question |
  |---|----------|
  | P1 | Does `transactionSync` nest, and does an inner throw undo only the inner part? |
  | P2 | Does `ctx.storage.transaction()` nest, and what does an inner rejection undo? |
  | P3 | Which of `boolean`, `Date`, `bigint`, `Uint8Array`, `undefined`, a plain object bind, and as what? |
  | P4 | How is the affected-row count of a write obtained: `rowsWritten`, or `select changes()`? |
  | P5 | What does the error of a unique, foreign-key, not-null and check violation carry (message, any code field)? |
  | P6 | Are `PRAGMA query_only` and `PRAGMA foreign_keys` permitted, and are foreign keys enforced by default? |
  | P7 | `sqlite_version()`, and whether `RETURNING` and `ON CONFLICT` work. |
  | P8 | While an async transaction awaits a timer, does a second request's statement run, and is it inside that transaction? |
- **Done when** — `test/do/probe.test.ts` passes under `pnpm test` with one assertion per
  assumption A1–A6 and one recorded answer per probe P1–P8; `DO-FINDINGS.md` holds
  `F01`–`F14`; a second run of the test leaves no Miniflare process behind.
- **Affected files** — `test/do/_workerd.ts`, `test/do/worker/probe.ts`,
  `test/do/probe.test.ts`, `test/do/cloudflare.d.ts`, `package.json` (devDependencies
  `miniflare`, `esbuild`), `docs/plans/v0-foundation/DO-FINDINGS.md`.
- **Effort / Value / Risk** — M / high / med. The value is the stop: if A3 or A5 is false
  the single-connection core is wrong for Durable Objects and should not be built as
  specified.
- **Implementation notes** — Declare the few Cloudflare types the worker needs in
  `test/do/cloudflare.d.ts` (a `declare module "cloudflare:workers"` and structural storage
  types); do not install `@cloudflare/workers-types`, whose globals collide with
  `@types/node`. Dispose Miniflare in `after()`. Check Miniflare's current option names
  against its own documentation before writing the harness: do not rely on memory for
  them. An assertion that pins a probe's answer is welcome (a workerd upgrade that changes
  it should fail loudly), as long as the answer is also written to `DO-FINDINGS.md`. If
  pnpm refuses a dependency's build script or a release that is too new, allow exactly
  that package in `pnpm-workspace.yaml`; do not switch the check off.

### 2. Single-connection driver core, node:sqlite, the conformance harness

- **Problem / observation** — A synchronous handle behind an async interface invites two
  bugs: another caller's statement lands inside an open transaction, or a promise that
  outlived its transaction writes into the next one. The prior implementation solves both
  inside its SQLite driver. Three more adapters here have exactly one connection and need
  the same solution.
- **Evidence** — `tmp/prior-art/engine/sqlite/driver.ts:152-163` (the context and the
  queue), `:181-187` (`query`: at once inside the open transaction's context, queued from
  anywhere else), `:189-222` (`BEGIN IMMEDIATE`, read-only as a deferred `BEGIN` with
  `PRAGMA query_only`), `:224-237` (nested call joins), `:251-275` (`exclusive` as a queue
  per name). Its documented cost: `tmp/prior-art/engine/docs/drivers.md` ("waits for
  itself").
- **Proposed change** —

  `src/single/backend.ts`:

  ```ts
  export type MaybePromise<T> = T | Promise<T>;

  /** Statements on one connection. */
  export interface Connection {
  	run(text: string, params: readonly unknown[]): MaybePromise<QueryResult<Row>>;
  	exec(script: string): MaybePromise<void>;
  }

  export interface SingleConnectionBackend extends Connection {
  	readonly dialect: DialectName;
  	readonly adapter: string;
  	/**
  	 * Run `fn` in one transaction: commit when it resolves, roll back when it rejects.
  	 * `fn` receives the connection its statements go through: a backend whose library
  	 * hands out a transaction object passes that, the others pass themselves.
  	 */
  	transaction<T>(fn: (inner: Connection) => Promise<T>, readOnly: boolean): Promise<T>;
  	/** A lock other processes honour, where the database has one. Resolves to its release. */
  	lock?(name: string, inTransaction: boolean): Promise<() => Promise<void>>;
  	classify(error: unknown): SqlErrorInfo;
  	close(): MaybePromise<void>;
  }
  ```

  `src/single/driver.ts`: `createSingleConnectionDriver(backend): Driver`. The core owns
  everything that is not the database: `statementOf` and the parameter rule, the queue,
  the `AsyncLocalStorage` context, the nested join, `exclusive` (a queue per name, plus
  `backend.lock` when the backend has one), and R1's always-a-promise. Transactions are
  callback-shaped at this seam because one backend (Durable Objects) cannot be given
  `BEGIN` as a statement.

  `src/sqlite/mod.ts`:

  ```ts
  import type { DatabaseSync } from "node:sqlite";
  /** A driver over a database the host opened. `close()` closes it. */
  export function createSqliteDriver(db: DatabaseSync): Driver;
  /** Opens one with the conventional settings: busy timeout, WAL for a file. */
  export function openSqlite(
  	path?: string, // ":memory:" by default
  	options?: { busyTimeout?: number }, // 5_000 by default; a whole number from 0
  ): Driver;
  ```

  The node:sqlite backend chooses rows or a count by `statement.columns().length`, not by
  a keyword test. A write transaction is `BEGIN IMMEDIATE`; a read-only one is a deferred
  `BEGIN` with `PRAGMA query_only` on for its length. Rows come back as plain objects.
  Capabilities: `{ sync: false, concurrentWriters: false, crossProcessLock: false }`
  (`sync` turns true in #3).

  The conformance harness, runner-agnostic so the same bodies run inside workerd later:

  ```ts
  // test/conformance/_suite.ts — imports nothing from node:test
  export interface Suite {
  	test(name: string, fn: () => void | Promise<void>): void;
  }
  export interface Fixture {
  	driver: Driver;
  	dispose(): Promise<void>;
  }
  export interface AdapterCase {
  	readonly name: string; // "sqlite", later "pg", "pg-client", "pglite", "do"
  	create(): Promise<Fixture>; // a database isolated from every other case
  }
  ```

  `test/conformance/driver.ts` exports `driverContract(suite, adapter)` with one case per
  rule R1–R10 of doc 01 #2. `test/conformance/_adapters.ts` is the registry of
  `AdapterCase`s. `test/conformance/driver.test.ts` is the only kind of file that imports
  `node:test`: it loops the registry and binds each body under `describe(adapter.name)`.
- **Done when** — `test/conformance/driver.test.ts` passes on the `sqlite` adapter with a
  case for each of R1–R10; `test/sqlite/sqlite.test.ts` passes for the busy timeout
  (default, custom, and a `TypeError` for a bad value), WAL on a file and not on
  `:memory:`, and a read-only transaction beside another handle's write;
  `test/unit/conformance-imports.test.ts` passes, proving no file in `test/conformance/`
  other than `*.test.ts` imports `node:test`; `test/unit/core-imports.test.ts` allows
  `node:async_hooks` in `src/single/` and nowhere in `src/core/`.
- **Affected files** — `src/single/backend.ts`, `src/single/driver.ts`,
  `src/sqlite/mod.ts`, `package.json` (`exports["./sqlite"]`), `test/conformance/_suite.ts`,
  `test/conformance/_adapters.ts`, `test/conformance/driver.ts`,
  `test/conformance/driver.test.ts`, `test/sqlite/sqlite.test.ts`,
  `test/unit/conformance-imports.test.ts`.
- **Effort / Value / Risk** — L / high / med.
- **Implementation notes** — Port, do not reinvent: the queue, the "context ends when the
  callback settles" flag and the `exclusive` lease chain are in the snapshot file line for
  line; the change is that `db.all` / `db.run` / `db.exec("BEGIN …")` become calls on the
  backend. Port the cases of `tmp/prior-art/engine/test/conformance/00-driver.test.ts`
  except `changeLock`, `json.*` and `likePrefix`. Each case creates and disposes its own
  fixture. Read `DO-FINDINGS.md` first: if F-entries show the backend seam cannot be met
  by Durable Objects, stop and say so.

### 3. The sync tier

- **Problem / observation** — D03: an adapter over a synchronous engine also offers a
  synchronous surface. Inside a Durable Object it is the form with no interleaving at
  all, and for a local tool it is simply the natural one. Two surfaces on one connection
  can step on each other, so what each refuses of the other has to be decided, not
  discovered.
- **Evidence** — A synchronous transaction's callback cannot be async:
  `transactionSync` "should not be declared `async` nor otherwise return a Promise"
  (storage API reference). The prior implementation has a synchronous block of the same
  shape: `tmp/prior-art/engine/sqlite/binding.ts:67-84`.
- **Proposed change** — `src/single/backend.ts` gains:

  ```ts
  export interface SyncBackend {
  	run(text: string, params: readonly unknown[]): QueryResult<Row>;
  	exec(script: string): void;
  	transaction<T>(fn: () => T, readOnly: boolean): T;
  }
  ```

  `createSingleConnectionDriver(backend, sync?)` returns a driver whose `sync` is a
  `SyncDriver` when a `SyncBackend` is given, sharing the async tier's state.
  `createSqliteDriver` passes one. The rules (D16):

  | # | Situation | Answer |
  |---|-----------|--------|
  | S1 | `db.sync.transaction(fn)` and `fn` returns a thenable | roll back, `TypeError` |
  | S2 | a nested `db.sync.transaction` | joins the open one |
  | S3 | a sync call from inside an open **async** transaction's own context | runs inside that transaction |
  | S4 | a sync call while an async transaction is open, from any other context | `TypeError`: it could only run inside a transaction it does not belong to |
  | S5 | an async `query`, `exec` or `transaction` issued from inside a sync transaction's callback | rejects with `TypeError`: it could only run after the callback returned, outside the transaction |
  | S6 | a sync call while async statements are queued but no transaction is open | runs at once |

  `test/conformance/sync.ts` exports `syncContract(suite, adapter)`: commit, rollback on
  throw, `rowCount`, `exec`, read-only, parameters, and S1–S6. The registry marks which
  adapters have a sync tier.
- **Done when** — `test/conformance/sync.test.ts` passes on `sqlite` with a case per rule
  S1–S6 and per item of the list above; `createSqliteDriver(db).capabilities.sync` is
  `true` and `.sync` is defined; the async contract of #2 still passes unchanged.
- **Affected files** — `src/single/backend.ts`, `src/single/driver.ts`,
  `src/sqlite/mod.ts`, `test/conformance/sync.ts`, `test/conformance/sync.test.ts`,
  `test/conformance/_adapters.ts`.
- **Effort / Value / Risk** — M / high / med.
- **Implementation notes** — `AsyncLocalStorage.run` works for a synchronous callback
  too, which is how S5 is detected: the sync transaction marks its context, and the async
  entry points read the mark. Errors of the sync tier are `TypeError` because each is a
  programming mistake, not something a database did.

### 4. Postgres pool adapter

- **Problem / observation** — A `BEGIN` sent through a pool is not a transaction: each
  statement may take a different connection. Two packages work around it with a helper
  that threads a client by hand, and that helper does not check `COMMIT`.
- **Evidence** — `tmp/prior-art/steve/with-transaction.ts:45-59`: `COMMIT` is awaited and
  its command tag ignored, and the client is released to the pool even after a failed
  `ROLLBACK`. `tmp/prior-art/cron/with-tx.ts:32-49` is the same. The prior implementation
  handles both: `tmp/prior-art/engine/pg/driver.ts:294-298` (checks the tag), `:301-310`
  and `:343` (destroys the connection). Its pinning: `:241-259`; `exclusive` as a polled
  session advisory lock keyed by name and schema: `:348-380`, `:386-459`; the pool `error`
  listener: `:134-142`; the `schema` option as `search_path`: `:181-194`.
- **Proposed change** — `src/pg/types.ts` declares `PgPoolLike` and `PgClientLike`
  structurally (`connect`, `query`, `release`, `end`, `on`, `listenerCount`), in the manner
  of `tmp/prior-art/migrate/pg.ts:29-46`. `src/pg/pool.ts` is the snapshot's driver without
  its `search` and `migrate` members and without the version floor, plus `exec` (the
  script sent as one simple query, no parameters) and the capability descriptor
  `{ sync: false, concurrentWriters: true, crossProcessLock: true }`.

  ```ts
  // src/pg/mod.ts
  export interface PgDriverOptions {
  	/** Applied as the whole search_path of every connection the driver checks out. */
  	schema?: string;
  }
  export function createPgDriver(pool: PgPoolLike, options?: PgDriverOptions): Driver;
  ```

  The registry gains a `pg` adapter whose fixture is a fresh schema per case, dropped
  with `CASCADE` afterwards. `test/_env.ts` reads `TEST_PG_HOST`, `TEST_PG_PORT`,
  `TEST_PG_DATABASE`, `TEST_PG_USER`, `TEST_PG_PASSWORD` and **throws** when
  `TEST_PG_DATABASE` is unset: a missing Postgres fails the suite, it does not shorten it
  (D20).
- **Done when** — `test/conformance/driver.test.ts` passes on `pg` as well as `sqlite`;
  `test/pg/transaction-pinning.test.ts` passes with the five cases of the snapshot file of
  that name; `test/pg/exclusive.test.ts` passes for two pools on one schema excluding each
  other, two schemas not waiting for each other, and a pool of one; `pnpm run test:pg` and
  `pnpm run test:sqlite` each select only their adapters' cases.
- **Affected files** — `src/pg/types.ts`, `src/pg/pool.ts`, `src/pg/mod.ts`,
  `package.json` (`exports["./pg"]`, devDependencies `pg`, `@types/pg`, the two scripts),
  `test/_env.ts`, `test/conformance/_adapters.ts`, `test/pg/_fixture.ts`,
  `test/pg/transaction-pinning.test.ts`, `test/pg/exclusive.test.ts`.
- **Effort / Value / Risk** — M / high / low. It is a port of tested code.
- **Implementation notes** — Keep the header comment of the snapshot driver: it is the
  explanation of why the lock is polled and never waited for in a statement. Suite names
  are load-bearing for the two scripts, as in the snapshot harness
  (`tmp/prior-art/engine/test/conformance/_harness.ts:14-20`): an adapter's cases start
  with its name. `@types/pg` is a devDependency for the tests only; `src/` does not import
  it.

### 5. One `pg.Client` as a driver

- **Problem / observation** — steve and cron accept a single `pg.Client` as well as a
  pool, and a client is one session: with their current helper, every statement issued
  while a transaction is open lands inside it, which is why cron limits a client to one
  worker. Under the single-connection core a client is simply another backend, and
  correctly serialized.
- **Evidence** — `tmp/prior-art/cron/with-tx.ts:51-64` (the client path),
  `tmp/prior-art/steve/with-transaction.ts:23-28` (telling the two apart by `totalCount`).
- **Proposed change** — An explicit second factory, so nothing is guessed from an object's
  shape:

  ```ts
  // src/pg/mod.ts
  export function createPgClientDriver(client: PgClientLike, options?: PgDriverOptions): Driver;
  ```

  `src/pg/client.ts` is a `SingleConnectionBackend`: `run` and `exec` are `client.query`;
  `transaction` is `begin` (or `begin isolation level repeatable read, read only`),
  `commit`, `rollback`; `lock` takes the same advisory lock keys as the pool driver, as a
  session lock outside a transaction and a transaction-scoped one inside, polled either
  way; `close` is `client.end()`. Capabilities:
  `{ sync: false, concurrentWriters: false, crossProcessLock: true }`.

  On the `pg` dialect a failed statement aborts the whole transaction. The core gains the
  one piece of dialect knowledge that needs: when a statement failed inside a transaction
  and the callback resolved anyway, the core rejects with `TransactionAbortedError` and
  the backend rolls back, instead of sending a `COMMIT` that would be answered with
  `ROLLBACK`.
- **Done when** — every conformance body registered so far passes on a `pg-client`
  adapter; `test/pg/client.test.ts` passes for an advisory lock taken through a client
  driver excluding a pool driver on the same schema, and for a statement issued outside
  an open transaction waiting for it rather than joining it.
- **Affected files** — `src/pg/client.ts`, `src/pg/mod.ts`, `src/single/driver.ts`,
  `test/conformance/_adapters.ts`, `test/pg/client.test.ts`.
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — Share the lock-key query and the polling loop with
  `src/pg/pool.ts` by moving them to `src/pg/lock.ts`; do not copy them. The documented
  difference from the pool driver is one line: a statement from outside an open
  transaction waits for it, where a pool would run it on another connection.

### 6. PGlite adapter

- **Problem / observation** — The brief's testing guidance: never use SQLite as a
  stand-in for Postgres, use PGlite for in-memory tests with Postgres semantics. PGlite is
  one connection with an async API and a transaction that hands out its own object.
- **Evidence** — PGlite's API reference: `query(sql, params)` resolves to
  `{ rows, affectedRows, fields }`; `exec(sql)` runs several statements and takes no
  parameters; `transaction(async (tx) => …)` commits when the callback resolves and rolls
  back when it rejects. The reference does not describe its error objects.
- **Proposed change** — `src/pglite/mod.ts`:

  ```ts
  export function createPgliteDriver(db: PgliteLike): Driver; // PgliteLike: query, exec, transaction, close
  ```

  A `SingleConnectionBackend`: `run` maps to
  `{ rows, rowCount: fields.length > 0 ? rows.length : (affectedRows ?? 0) }`;
  `transaction` calls `db.transaction` and passes a `Connection` over its `tx`; a
  read-only transaction issues `set transaction isolation level repeatable read, read
  only` as its first statement; `classify` is `classifyPg`. Capabilities:
  `{ sync: false, concurrentWriters: false, crossProcessLock: false }`. The registry gains
  a `pglite` adapter, one in-memory instance per case.
- **Done when** — every conformance body registered so far (driver, errors, builders,
  decoders, migrate) passes on `pglite`; `test/pglite/pglite.test.ts` passes for the
  error classes of the four constraint violations raised for real, and for
  `TransactionAbortedError` when a callback swallows a failed statement.
- **Affected files** — `src/pglite/mod.ts`, `package.json` (`exports["./pglite"]`,
  devDependency `@electric-sql/pglite`), `test/conformance/_adapters.ts`,
  `test/pglite/pglite.test.ts`.
- **Effort / Value / Risk** — M / med / med. The risk is the undocumented error shape: if
  PGlite's errors carry no SQLSTATE `code`, return `blocked` with what they do carry
  rather than classify by message.
- **Implementation notes** — Check the installed PGlite's API against its own types
  before writing the backend. The aborted-transaction tracking added in #5 is what makes
  R3 hold here, since PGlite ends the transaction itself.

### 7. Durable Objects adapter

- **Problem / observation** — The last adapter and the hardest: no `BEGIN`, a synchronous
  engine, and a runtime `node:test` does not run in.
- **Evidence** — #1 and `DO-FINDINGS.md`.
- **Proposed change** — `src/do/mod.ts`:

  ```ts
  /** `storage` is a SQLite-backed Durable Object's `ctx.storage`. */
  export function createDoDriver(storage: DoStorageLike): Driver; // .sync is defined
  ```

  The sync tier's `SyncBackend` is `storage.sql.exec` and `storage.transactionSync`. The
  async tier is the single-connection core over `storage.transaction`. Parameters, the
  affected-row count and the classifier follow F-entries P3, P4 and P5. `close()` does
  nothing. Capabilities: `{ sync: true, concurrentWriters: false, crossProcessLock: false }`.
  Read-only transactions do what the review of T12 decided from P6. The adapter requires
  the `nodejs_compat` flag (D24).

  The conformance bodies run inside workerd: `test/do/worker/conformance.ts` is a Durable
  Object that collects the cases of a named body into an in-memory `Suite`, runs them
  against `createDoDriver(ctx.storage)` with a fresh object per case, and returns one
  result per case. `test/do/conformance.test.ts` turns each result into a `node:test`
  case named `do <case>`.
- **Done when** — `test/do/conformance.test.ts` passes for every body: driver, sync,
  errors, builders, decoders, migrate; `README.md` and `docs/` describe `./do`, its
  `nodejs_compat` requirement and the rule that an async transaction must not await
  external I/O.
- **Affected files** — `src/do/mod.ts`, `package.json` (`exports["./do"]`),
  `test/do/worker/conformance.ts`, `test/do/conformance.test.ts`, `README.md`, `API.md`,
  `AGENTS.md`, `docs/architecture.md`.
- **Effort / Value / Risk** — L / med / high.
- **Implementation notes** — A conformance case that cannot hold on Durable Objects for a
  reason `DO-FINDINGS.md` records is not skipped silently: the registry entry lists it
  under `except`, with the F-entry as its reason, and the body reports it as an explicit
  exception. A case that fails for any other reason is a failure. This row runs after the
  docs rows on purpose: if it blocks, 0.1.0 is still documented and releasable without
  `./do`.

## Open questions / decisions needed

None before T04. T12 decides, from `DO-FINDINGS.md`: what a read-only transaction does on
Durable Objects when P6 shows it cannot be enforced (refuse with `TypeError`, or allow it
unenforced), and whether D24 stands.
