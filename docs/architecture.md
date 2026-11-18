# Architecture

## Overview

sqlkit is three layers over a database the host connected:

1. **Fragments and conventions** (`src/core/`): `sql` fragments, the parameter rule,
   typed errors and their classifiers, statement builders, row decoders, retry, health.
   Pure functions, runtime-neutral.
2. **The driver contract** (`src/core/contract.ts`): `Driver` (async, every adapter) and
   `SyncDriver` (`driver.sync`, on an adapter whose engine is synchronous).
3. **Adapters**: one entry point each, implementing the contract over a client the host
   built. Two shapes: a Postgres pool, and the single-connection driver core
   (`src/single/`) with a small backend per database.

The migrate wiring (`./migrate`) sits beside them and runs over any `Driver`.

An app commits to one dialect (`pg` or `sqlite`) and may use its SQL freely. sqlkit is
not an ORM and not a query builder.

## Component Map

```
host code ── sql`…`, builders, decoders, withRetry, checkHealth
   │
   ▼
"."  src/mod.ts ─ re-exports src/core/ (runtime-neutral)
   │   sql · params · contract · errors · classify-pg · classify-sqlite
   │   build · decode · retry · health
   │
   ├── "./pg"      src/pg/pool.ts ────── pool: pins a connection per transaction
   │
   ├── src/single/driver.ts ───────────── single-connection core (AsyncLocalStorage)
   │      ▲ SingleConnectionBackend (+ SyncBackend where the engine is synchronous)
   │      ├── "./sqlite"  src/sqlite/mod.ts   node:sqlite (has SyncBackend)
   │      ├── "./pg"      src/pg/client.ts    one pg.Client
   │      ├── "./pglite"  src/pglite/mod.ts   PGlite
   │      └── "./do"      src/do/mod.ts       Durable Objects storage (has SyncBackend)
   │
   └── "./migrate" src/migrate/mod.ts ── @marianmeres/migrate hooks over any Driver
       "./migrate/files" src/migrate/files.ts ── SQL files as versions (node:fs)
```

## Data Flow

One `query` call, on every adapter:

```
query(statement | text, params?)
  → statementOf(statement, params, dialect)   render a fragment ($1… or ?), or pass text
  → normalizeParams(params, dialect)          the parameter rule
  → the database (pool connection / backend)
  → { rows: plain objects, rowCount }
  ✗ a driver error → classifier → toSqlError → SqlError subclass, driver error as `cause`
```

## Key Files

| File                     | Owns                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `src/core/sql.ts`        | `Sql` fragments, `render`, `ident`, `json`, quoting                          |
| `src/core/params.ts`     | the parameter rule (`normalizeParam`, `normalizeParams`)                     |
| `src/core/contract.ts`   | `Driver`, `SyncDriver`, R1–R11 and S1–S6 in doc comments, `statementOf`      |
| `src/core/errors.ts`     | `SqlError`, its subclasses, `toSqlError`                                     |
| `src/core/classify-*.ts` | one classifier per dialect: driver error → `SqlErrorInfo`                    |
| `src/core/build.ts`      | `insert`, `update`, `upsert`, `deleteFrom`, `whereEq`, `and`, `or`, `inList` |
| `src/core/decode.ts`     | `decode.*`, `decodeRow`, `decodeRows`                                        |
| `src/core/retry.ts`      | `withRetry`                                                                  |
| `src/core/health.ts`     | `checkHealth`, `createHealthMonitor`                                         |
| `src/single/backend.ts`  | the backend seam: `SingleConnectionBackend`, `SyncBackend`                   |
| `src/single/driver.ts`   | `createSingleConnectionDriver`: the one-connection rule, both tiers          |
| `src/pg/pool.ts`         | `createPgDriver` over a pool                                                 |
| `src/pg/lock.ts`         | the polled advisory lock both Postgres drivers take                          |
| `src/pg/session.ts`      | what the two Postgres drivers share: read-only `BEGIN`, `COMMIT` check       |
| `src/pg/types.ts`        | the structural node-postgres shapes                                          |
| `src/do/mod.ts`          | `createDoDriver`: a Durable Object's storage as a backend, both tiers        |

## The Single-Connection Rule

Lives in `src/single/driver.ts`, written once. node:sqlite, one `pg.Client`, PGlite and a
Durable Object's storage are backends under it; a backend only runs what it is handed.

- Everything takes its turn on the one connection.
- A statement runs inside the open transaction only when that transaction's own callback
  (or what it awaits) issued it. The context is carried by `AsyncLocalStorage`.
- From anywhere else a statement queues behind the transaction.
- "Inside" ends when the callback settles: a promise that outlives its transaction writes
  outside it.
- A nested `transaction()` joins the open one. The backend is asked for a transaction only
  at the top level.
- The `tx` a callback receives is the driver itself: the context decides, not the handle.
- **Known cost:** a statement issued during a transaction from a context that lost it (a
  callback handed to an emitter or a queue created outside) waits for the transaction that
  waits for it. Bind such a callback inside the transaction (`AsyncLocalStorage.bind`).
- On the `pg` dialect the core tracks a failed statement: a transaction whose last
  failure no later statement got past rejects with `TransactionAbortedError` (the failure
  as `cause`) instead of committing. SQLite has no aborted state.
- `exclusive()` is an in-process queue per lock name, plus `backend.lock` where the
  backend has one (then `capabilities.crossProcessLock` is true). Inside an open
  transaction it runs at once.

The pool driver (`src/pg/pool.ts`) keeps the same contract its own way: `transaction()`
pins one pooled connection and carries it through `AsyncLocalStorage`; a statement from
outside runs on another connection at once.

## Adapters

| Entry      | Factory                                               | `adapter`           | Dialect  | Shape             | `sync` | `concurrentWriters` | `crossProcessLock` |
| ---------- | ----------------------------------------------------- | ------------------- | -------- | ----------------- | ------ | ------------------- | ------------------ |
| `./sqlite` | `createSqliteDriver(db)`, `openSqlite(path, options)` | `"node:sqlite"`     | `sqlite` | single connection | true   | false               | false              |
| `./pg`     | `createPgDriver(pool, options)`                       | `"pg"`              | `pg`     | pool              | false  | true                | true               |
| `./pg`     | `createPgClientDriver(client, options)`               | `"pg-client"`       | `pg`     | single connection | false  | false               | true               |
| `./pglite` | `createPgliteDriver(db)`                              | `"pglite"`          | `pg`     | single connection | false  | false               | false              |
| `./do`     | `createDoDriver(storage)`                             | `"durable-objects"` | `sqlite` | single connection | true   | false               | false              |

- **The host builds the client.** No adapter imports its driver library, not even its
  types: each declares the shape it takes structurally (`PgPoolLike`,
  `PgStandaloneClientLike`, `PgliteLike`, `DoStorageLike`). node:sqlite is built into
  Node. The package has no peer dependency.
- **`close()`** ends the client the adapter was given, and is idempotent. A host that keeps
  its client does not call it. On Durable Objects it ends the driver only: the storage is
  the object's.
- **node:sqlite**: a transaction is `BEGIN IMMEDIATE`; a read-only one a deferred `BEGIN`
  with `query_only` on. `createSqliteDriver` sets nothing on the handle; `openSqlite` sets
  a busy timeout (5000 ms) and WAL for a file.
- **Postgres**: a read-only transaction is `REPEATABLE READ READ ONLY`. `COMMIT` is
  checked, not trusted (Postgres answers an aborted transaction's `COMMIT` with
  `ROLLBACK`). `exclusive` is an advisory lock keyed by the name and `current_schema()`,
  polled with `pg_try_advisory_lock`. `options.schema` binds the driver to one schema.
  `query()` uses the extended protocol, so a text of several statements is refused by the
  server; `exec()` is a simple query.
- **PGlite**: Postgres compiled to WebAssembly, in process: the in-memory database for
  tests of code that runs on Postgres. No cross-process lock.

### Durable Objects

`src/do/mod.ts`, `createDoDriver(ctx.storage)`: a backend of the single-connection core
over a SQLite-backed Durable Object's storage, with a `SyncBackend` too, since `sql.exec`
is synchronous. It needs the `nodejs_compat` compatibility flag, for `AsyncLocalStorage`
(D24). Everything it does differently was observed in real workerd first: findings
F01–F15 in [DO-FINDINGS.md](./plans/v0-foundation/DO-FINDINGS.md), each pinned by
`test/do/probe.test.ts`, with the workerd version it was observed on.

- **Transactions** are `storage.transaction` (async tier) and `storage.transactionSync`
  (sync tier): workerd refuses every transaction statement through `sql.exec` (F04).
- **An open async transaction holds the whole object** (F14): no other request runs until
  it settles. An async transaction must not await external I/O.
- **Read-only by detection** (F12, D34.7): `query_only` is not authorized. Inside a
  read-only transaction a statement that wrote (`rowsWritten` of the text's last
  statement, or a move of `total_changes()`) throws a `ReadOnlyError` with code `8`, and
  the transaction throws it again after the callback, inside the storage transaction, so
  the write rolls back. DDL that is not a text's last statement goes unseen.
- **R11 is not enforced** (F01): `sql.exec` runs every statement of a text given no values.
- **A deferred constraint resets the object** (F15): workerd checks it when the request's
  implicit transaction commits, not when `transaction()` ends.
- **Values and rows** (F09, F10): a `bigint` binds as a number in the safe-integer range
  and is a `TypeError` beyond; a blob's `ArrayBuffer` is handed on as a `Uint8Array`;
  `rowCount` of a plain write is `changes()`, read right after it.
- **Errors** (F11) carry no code; `classifySqlite` reads the code names at the end of the
  message.

The conformance bodies run inside workerd: `test/do/worker/conformance.ts` is a Durable
Object that holds every body and runs one case per request, on a fresh object, and
`test/do/conformance.test.ts` registers each as a `node:test` case under `describe("do")`.
That worker is the `do` adapter's registry entry. A case that cannot hold there is listed
under its `except`, with the finding as the reason, and reported as skipped with it: R11
(F01) and the two deferred-constraint cases of the `errors` body (F15).
`test/do/adapter.test.ts` holds what only this adapter does.

## The Two Tiers

`driver.sync` exists where the engine is synchronous (node:sqlite, Durable Objects). Its
transaction callback is synchronous: an async callback returns at its first `await`. The
tiers share one connection, so each refuses what would land in the wrong transaction. The
rules, as `src/core/contract.ts` states them and `test/conformance/sync.ts` holds every
adapter to:

| Rule | Behaviour                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| S1   | A transaction callback that returns a thenable rolls back, with a `TypeError`.                                                     |
| S2   | A nested `transaction` joins the open one, as it was opened.                                                                       |
| S3   | A sync call from inside an open async transaction's own callback runs inside that transaction.                                     |
| S4   | A sync call while an async transaction is open, from anywhere else, is a `TypeError`.                                              |
| S5   | An async call from inside a sync transaction's callback rejects with a `TypeError`: it could only run after the callback returned. |
| S6   | With no transaction open, a sync call runs at once, ahead of queued async work.                                                    |

A refused sync call throws its `TypeError` at the call.

## The Contract Rules

As `src/core/contract.ts` states them; `test/conformance/driver.ts` has at least one case
per rule, named `R<n>: …`.

| Rule | Behaviour                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `query` and `exec` always answer with a promise: a failing statement rejects, it never throws at the call.                                                                 |
| R2   | `rowCount` is as `QueryResult` says, for a `SELECT`, a plain write and a write with `RETURNING`.                                                                           |
| R3   | `transaction` commits when `fn` resolves and rolls back when it rejects. On `pg` a callback that swallowed a failure gets a rejection; SQLite commits the rest.            |
| R4   | A nested `transaction` joins the open one, as it was opened.                                                                                                               |
| R5   | A statement belongs to the transaction whose callback issued it, and to no other.                                                                                          |
| R6   | "Inside" ends when the callback settles: a promise that outlives its transaction writes outside it.                                                                        |
| R7   | `readOnly` reads one snapshot and refuses a write.                                                                                                                         |
| R8   | `exclusive` serializes callers of one name, is re-entrant, lets two names run together, releases on rejection, and inside an open transaction belongs to that transaction. |
| R9   | `exec` runs every statement of a script and joins the open transaction.                                                                                                    |
| R10  | Parameters follow the one parameter rule. Rows are plain objects. Bytes read back as a `Uint8Array`.                                                                       |
| R11  | `query` runs one statement: a text holding more is refused before any of it runs. A script goes through `exec`. Not on Durable Objects (F01).                              |

A non-write's `rowCount` (DDL, a `SET`, a pragma) is a number and nothing more.

## The Error Boundary

- Every adapter wraps what its driver throws, at its boundary, into a `SqlError` subclass
  of the kind its dialect's classifier reads, with the driver's error as `cause` and its
  message as the message.
- Where: the pool driver guards every node-postgres call (`guard` in `src/pg/pool.ts`); the
  single-connection core wraps everything a backend throws, on both tiers, with
  `backend.classify`; `openSqlite` wraps opening the file.
- Never wrapped: what a transaction's or a section's callback threw (the caller's own),
  and a `TypeError` (a programming mistake, from the driver or from a backend).
- One classifier per dialect (`classifyPg`, `classifySqlite`), not per adapter:
  `checkHealth` classifies by dialect alone.
- `SqlError.retryable` is true for `serialization`, `deadlock`, `busy` and `connection`;
  `withRetry` retries on it.

## Migrations

`createMigrate(db, options)` (`src/migrate/mod.ts`) is a `@marianmeres/migrate` instance
whose hooks are the driver's:

| Hook       | `crossProcessLock` true (pg, pg-client)   | otherwise (node:sqlite, PGlite, DO)    |
| ---------- | ----------------------------------------- | -------------------------------------- |
| `wrapRun`  | `db.exclusive("migrate:<table>", run)`    | `db.transaction(run)`                  |
| `wrapStep` | `db.transaction(run)`, committed per step | `db.transaction(run)`, joining the run |

- Where the lock crosses processes a failed step is undone alone; elsewhere it undoes the
  whole run.
- The version table's DDL and the lock name match the package's own helpers, so either can
  continue the other's database.
- One active version is stored, not a ledger: a version registered later below the active
  one is never applied.
- `addSqlFiles(migrate, dir)` (`src/migrate/files.ts`, Node only) registers
  `<version>[__<label>].up.sql` and `.down.sql` files; each file is one `exec`.

## External Dependencies

| Package                                    | Kind    | Why                                                   |
| ------------------------------------------ | ------- | ----------------------------------------------------- |
| `@marianmeres/migrate`                     | runtime | the versioning the migrate wiring hooks into          |
| `pg`, `@electric-sql/pglite`               | dev     | the clients the tests build; never imported by `src/` |
| `miniflare`, `esbuild`                     | dev     | workerd for the Durable Objects tests                 |
| `typescript`, `@biomejs/biome`, `@types/*` | dev     | typecheck, lint, format                               |

## Security Boundaries

- A value never enters SQL text: `sql` binds every interpolated value, and only a fragment
  a builder made (branded with a `Symbol.for` key JSON cannot carry) is spliced. A parsed
  request body shaped like a fragment is bound as a value.
- `raw(text)` is the one way to put caller text into SQL; the caller owns its safety.
- Identifiers go through `ident` / `quoteIdent`; an empty name or a NUL is a `TypeError`.
- A decoder's refusal names the column and the type found, never the value.
