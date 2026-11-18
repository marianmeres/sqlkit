# Implementation Progress — sqlkit v0 foundation
<!-- tracker: v1 -->

Living tracker for acting on [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
A fresh conversation should read this file first, then the one section its row's `Source`
names, then the decisions its row's `Decisions` cell names.

**Status legend:** ⬜ ready · 🚧 in progress · ⏸️ blocked/awaiting decision · 🔒 human-only · ✅ done · ⏭️ deferred

> Convention: one branch for the sprint, one commit per task. What every task does, beyond
> its own section:
>
> - **Checks the finding first.** Each section was verified on 2026-11-18 against the
>   snapshot in `tmp/prior-art/` and Node 26.13.1. Line numbers are the snapshot's. If
>   `tmp/prior-art/` is missing (it is gitignored), or a premise no longer holds, say so
>   and stop rather than build something near it.
> - **Leaves `pnpm run ci` green**: typecheck, Biome, the whole suite on every registered
>   adapter. A missing Postgres fails; nothing is skipped to get to green.
> - **Stays public-clean (D02).** No committed file names a private package. Prior art is
>   "the prior implementation", cited as `tmp/prior-art/…`. Read `tmp/prior-art/README.md`
>   for what to take from each file and what to leave.
> - **Puts behaviour in a conformance body.** A rule of the contract is a case under
>   `test/conformance/`, in a file that does not import `node:test`, and runs on every
>   registered adapter. An adapter-specific test lives under `test/<adapter>/` and says
>   why it is one.
> - **Keeps `src/core/` runtime-neutral**: no `node:*`, no bare package import.
> - **Adds no dependency its section does not name.**
> - **Writes erasable TypeScript** with explicit `.ts` import extensions, and runs
>   `pnpm run format` before committing.
> - **From T17 on, updates the docs it invalidates** (`README.md`, `API.md`, `AGENTS.md`,
>   `docs/`).

## Sprint (v0 foundation: core, adapters, conventions, docs)

```sprint
Branch: `sprint/v0-foundation`
Verify: pnpm run ci
```

**Pre-flight.** T01 is done by hand and is what makes the `Verify:` command pass at all;
[04](./04-scaffold-docs-release.md) #1 lists it. The run stops at T12 on purpose and is
started again after the owner ticks it. No `Options:` line: nineteen machine rows in two
runs of ten and nine fit the driver's defaults (`sprint -h` prints them); T33 is the
ninth of the second run, added by the T12 review (D34). Rehearse with
`sprint docs/plans/v0-foundation --dry-run`.

| Status | ID  | Deps | Task | Source | Decisions | Commit |
| ------ | --- | ---- | ---- | ------ | --------- | ------ |
| ✅ | T01 | — | Owner pre-flight: scaffold, `.claude/settings.json`, test database and `.env`, first commit on `master` | [04](./04-scaffold-docs-release.md) #1 | D02 D20 D21 | 00ae644 |
| ✅ | T02 | T01 | `sql` fragments: `sql`, `raw`, `bind`, `join`, `ident`, `json`, `render`; the core-imports guard | [01](./01-core.md) #1 | D02 D21 | 172963c |
| ✅ | T03 | T02 | Contract types, the parameter rule, `SqlError` classes, the pg and sqlite classifiers | [01](./01-core.md) #2, #3 | D07 D10 D11 D14 D17 | 7b3a6a3 |
| ✅ | T04 | T03 | Durable Objects spike: workerd harness under `node:test`, assumptions A1–A6, probes P1–P8, `DO-FINDINGS.md` | [02](./02-adapters.md) #1 | D03 D05 D20 D24 | d356f3f |
| ✅ | T05 | T04 | Single-connection driver core, the node:sqlite adapter (async tier), the runner-agnostic conformance harness and the `driver` body | [02](./02-adapters.md) #2 | D09 D12 D13 D15 D20 D23 | aa3a281 |
| ✅ | T06 | T05 | Sync tier on node:sqlite and the tier rules S1–S6; the `sync` conformance body | [02](./02-adapters.md) #3 | D03 D16 | 6f629e0 |
| ✅ | T07 | T06 | Postgres pool adapter: pinned transactions, `exclusive`, `schema`; the `pg` fixtures and pg-only suites | [02](./02-adapters.md) #4 | D09 D12 D13 D20 | 5009b50 |
| ✅ | T08 | T07 | Typed errors end to end: adapters wrap at the boundary; the `errors` body and the adapter-specific error suites | [01](./01-core.md) #4 | D07 D17 | 89561ae |
| ✅ | T09 | T08 | Statement builders: `insert`, `update`, `upsert`, `deleteFrom`, `whereEq`, `and`, `or`, `inList` | [03](./03-conventions.md) #1 | D08 | f4fac26 |
| ✅ | T10 | T09 | Explicit row decoders: `decode.*`, `decodeRow`, `decodeRows` | [03](./03-conventions.md) #5 | D08 | b196fbe |
| ✅ | T11 | T10 | `withRetry`, `checkHealth`, `createHealthMonitor` | [03](./03-conventions.md) #3 | D08 D17 | 281d3cd |
| ✅ | T12 | T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 | Owner review of the API and of `DO-FINDINGS.md`; D09–D24 confirmed or changed | [01](./01-core.md) #5 | D09 D10 D11 D14 D15 D16 D17 D24 D34 | — |
| ✅ | T13 | T12 | Migrate wiring over a `Driver` (`./migrate`), its conformance body, the interop tests | [03](./03-conventions.md) #2 | D06 D18 D21 | — |
| ✅ | T14 | T13 | SQL files as versions (`./migrate/files`) | [03](./03-conventions.md) #4 | D06 D19 D36 | — |
| ✅ | T15 | T14 | `createPgClientDriver`: one `pg.Client` as a single-connection backend; aborted-transaction tracking in the core | [02](./02-adapters.md) #5 | D08 D15 D34 | — |
| ✅ | T16 | T15 | PGlite adapter (`./pglite`) | [02](./02-adapters.md) #6 | D05 D15 D34 | — |
| ✅ | T33 | T12 | A timeout on the health check: `timeoutMs` on `checkHealth` and `createHealthMonitor` | [03](./03-conventions.md) #6 | D33 D34 | — |
| ✅ | T17 | T16 T33 | Agent docs: `AGENTS.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/conventions.md`, `docs/tasks.md`, `mcp-include.txt`; the docs-links test | [04](./04-scaffold-docs-release.md) #2 | D02 | — |
| ⬜ | T18 | T17 | Human docs: `README.md`, `API.md`; the api-docs and exports tests | [04](./04-scaffold-docs-release.md) #3 | D02 D22 | — |
| ⬜ | T19 | T18 | Durable Objects adapter (`./do`): both tiers, every conformance body run inside workerd | [02](./02-adapters.md) #7 | D05 D16 D24 D34 | — |
| ⬜ | T20 | T19 | Archive this plan set; copy the backlog to `docs/backlog.md` | [04](./04-scaffold-docs-release.md) #4 | D22 | — |

Row order is run order. T19 comes after the docs rows on purpose: if it blocks, the
package is documented and releasable without `./do`. T33 comes before them, so they
document it. The release is not a row (D22).

## Backlog (ranked, not scheduled)

| Status | ID  | Rank | Task | Source |
| ------ | --- | ---- | ---- | ------ |
| 🔒 | T21 | 1 | Owner: make the package public on npm. Precondition for T22–T24. Irreversible. | [04](./04-scaffold-docs-release.md) |
| ⬜ | T22 | 2 | Adopt in steve: its transaction, retry, health and quoting helpers and its insert helper go; needs its own plan | [00](./00-overview-and-roadmap.md) |
| ⬜ | T23 | 3 | Adopt in cron: same helpers; needs its own plan | [00](./00-overview-and-roadmap.md) |
| ⬜ | T24 | 4 | Adopt in kv: its Postgres and SQLite adapters; needs its own plan | [00](./00-overview-and-roadmap.md) |
| ⬜ | T25 | 5 | Adopt in the prior implementation: its driver seam is replaced by sqlkit, its portable dialect stays on top; needs its own plan, including the step-ledger to active-version mapping | [00](./00-overview-and-roadmap.md) |
| ⬜ | T26 | 6 | Savepoints (`tx.savepoint(fn)`), so a migrate run on a single-connection adapter keeps the steps before a failed one | [03](./03-conventions.md) #2 |
| ⬜ | T27 | 7 | `better-sqlite3` adapter: a second `SyncBackend`. No consumer yet. | [02](./02-adapters.md) |
| ⬜ | T28 | 8 | `postgres.js` adapter. No consumer yet. | [02](./02-adapters.md) |
| ⬜ | T29 | 9 | Prepared-statement cache in the node:sqlite backend | [00](./00-overview-and-roadmap.md) |
| ⬜ | T30 | 10 | Export the conformance bodies as `./testing`, for adapters written outside this package | [02](./02-adapters.md) #2 |
| ⬜ | T31 | 11 | An isolation-level option on `transaction` | [00](./00-overview-and-roadmap.md) |
| ⬜ | T32 | 12 | Dialect-specific SQL file variants (`.pg.sql`, `.sqlite.sql`) for libraries that support both | [03](./03-conventions.md) #4 |

## Decisions log

D01–D08 are the owner's, from the interview of 2026-11-18. D09–D24 are the plan author's
and are **open to veto until the row that cites them runs**: change one by editing its
entry and the section it names. T12 is the scheduled moment to do that for the second half.
T12 has run: D34 records what it confirmed and what it changed, and an entry above it that
D34 changes says so where it stands.

- **D01** (2026-11-18, owner) — Extract now, adopt later. sqlkit is a port and a
  generalization of the prior implementation's driver seam. Moving any existing package
  onto sqlkit is not in this plan. Rejected: a greenfield rewrite; adopting in the same
  plan.
- **D02** (2026-11-18, owner) — Public-clean, restricted first. Source and docs are
  written as if public from the first file: no private package is named, and prior art is
  cited as `tmp/prior-art/…` (gitignored, with its own README). The package is published
  to npm with `access: restricted` during 0.x; making it public is the owner's later step
  (T21). Rejected: public from 0.1; private for good.
- **D03** (2026-11-18, owner) — Async everywhere, plus a sync tier. Every adapter
  implements `Driver`; an adapter over a synchronous engine also exposes `driver.sync`.
  Reason: an async callback returns at its first `await`, so it cannot run inside a
  synchronous transaction. Rejected: async only.
- **D04** (2026-11-18, owner) — The consumers the design is held to are steve, cron and
  kv, and the prior implementation's host. No Durable Objects project is waiting.
- **D05** (2026-11-18, owner) — Adapters in this plan: Postgres through node-postgres,
  node:sqlite, PGlite, and Durable Objects last, behind an early spike. `postgres.js` and
  `better-sqlite3` are backlog (T27, T28).
- **D06** (2026-11-18, owner) — Migrations build on `@marianmeres/migrate` 2.x, through
  its hooks. Rejected: a forward-only ledger of applied step ids inside sqlkit (the plan
  author's recommendation). Accepted consequence, stated in that package's README: one
  active version is stored, so a version registered later below it is never applied.
- **D07** (2026-11-18, owner) — Errors are wrapped at the adapter boundary into
  `SqlError` subclasses with the driver's error as `cause`. Rejected: leaving driver
  errors untouched and classifying on demand.
- **D08** (2026-11-18, owner) — The v0 conventions are statement builders, explicit row
  decoders, retry and health, and support for a single `pg.Client`.
- **D09** (2026-11-18, plan author) — A statement belongs to the transaction whose
  callback issued it, carried by `AsyncLocalStorage`; the `tx` a callback receives is the
  driver itself. Follows from D04: the prior implementation's host relies on exactly this
  rule. Known cost: on a single connection, a statement issued during a transaction from
  a context that lost it waits for the transaction that awaits it.
- **D10** (2026-11-18, plan author) — The contract is `query` (rows and a count),
  `exec` (a parameterless script), `transaction`, `exclusive`, `close`, and `sync?`.
  `query` takes an `Sql` or text with parameters. The brief's `exec` as "affected count"
  is covered by `rowCount`.
- **D11** (2026-11-18, plan author) — Capabilities are `sync`, `concurrentWriters` and
  `crossProcessLock`. Not `returning`, `jsonb` or `arrays`: the dialect implies them.
- **D12** (2026-11-18, plan author) — The host builds the client. Adapters declare the
  shape they take structurally and import no driver library, so the package has no peer
  dependency. node:sqlite is typed with `import type`, being built in.
- **D13** (2026-11-18, plan author) — `close()` ends the client the adapter was given
  and is idempotent. A host that keeps its client does not call it.
- **D14** (2026-11-18, plan author) — One parameter rule, applied before any driver sees
  a value: `undefined` is `NULL`; a plain object is JSON text; an array is a Postgres
  array on `pg` and a `TypeError` on `sqlite`; `json(v)` is JSON text everywhere; on
  `sqlite` a boolean is `1`/`0` and a `Date` is ISO text. Table in [01](./01-core.md) #2.
- **D15** (2026-11-18, plan author) — One single-connection driver core serves
  node:sqlite, `pg.Client`, PGlite and the async tier of Durable Objects. Its backend
  seam has callback-shaped transactions, because one backend cannot be sent `BEGIN`.
- **D16** (2026-11-18, plan author) — The two tiers refuse each other where a call would
  land in the wrong transaction: rules S1–S6 in [02](./02-adapters.md) #3.
- **D17** (2026-11-18, plan author) — Error kinds are `unique`, `foreign_key`,
  `not_null`, `check`, `serialization`, `deadlock`, `busy`, `connection`, `read_only`,
  `aborted`, `unknown`. Four of them are `retryable`: `serialization`, `deadlock`, `busy`
  and `connection`. `constraint`, `table` and `columns` are filled where the database
  reports them and typed optional. An error thrown by callback code is never wrapped. A
  programming mistake is a `TypeError`.
- **D18** (2026-11-18, plan author) — The migrate wiring locks a run with `exclusive`
  where the adapter's lock crosses processes, and with one transaction elsewhere, where a
  failed step therefore undoes the whole run. The version table and the lock name are
  identical to the package's own helpers, so either can continue the other's database.
  No savepoints in v0 (T26).
- **D19** (2026-11-18, plan author) — SQL files are `<version>[__<label>].up.sql` and
  `.down.sql`. Anything else ending in `.sql`, a down without an up, a duplicate and an
  empty directory are refusals. Loading is Node-only and a separate entry point.
- **D20** (2026-11-18, plan author) — Tests: `TEST_PG_*` names the Postgres, and a
  missing one fails the suite; every Postgres case gets a schema of its own; conformance
  bodies import no `node:test`; Durable Objects run in Miniflare started from
  `node:test`; a server a test starts takes an OS-assigned port.
- **D21** (2026-11-18, plan author) — Tooling: one package with subpath exports
  (layout in [02](./02-adapters.md)); Node ≥ 24.12, pnpm, Biome, `node:test`,
  `noUncheckedIndexedAccess`; npm only, no JSR (the standing runtime policy: JSR only
  while a Deno consumer exists); `@marianmeres/migrate` is a regular dependency.
- **D22** (2026-11-18, plan author) — The release is not a row. The version stays
  `0.0.0` through the sprint and the owner's `pnpm run rpm` makes it `0.1.0`.
- **D23** (2026-11-18, plan author) — No version floor is asserted and no pragma is set
  on a handle the host built. `openSqlite()` is the convenience that opens one with the
  conventional settings.
- **D24** (2026-11-18, plan author) — The Durable Objects adapter requires the
  `nodejs_compat` flag, for `AsyncLocalStorage`. T04 checks that it is enough; T12
  confirms or overturns this.
- **D25** (2026-11-18, T02 session) — A fragment is recognized by a non-enumerable
  `Symbol.for` brand its builders set, not by `kind: "sql"` alone as the prior
  implementation's `isSql` did. Reason: D14 binds a plain object as JSON, so a parsed
  request body shaped `{ "kind": "sql", "chunks": [...] }` would otherwise be spliced into
  the statement as SQL text. A look-alike is bound as a value by `sql`, and refused with a
  `TypeError` by `join` and `render`. The `Sql` interface is unchanged; `Symbol.for` lets
  two copies of the package accept each other's fragments. Also from T02: a template chunk
  with an invalid escape (cooked `undefined`) is a `TypeError`, not dropped text. Open to
  veto at T12 ([01](./01-core.md) #1).
- **D26** (2026-11-18, T03 session) — Found while writing the classifiers and the
  parameter rule; open to veto at T12 ([01](./01-core.md) #2, #3).
  1. Postgres names no constraint on a not-null violation: on 18.6 a `23502` carries
     `table` and `column` only (unique, foreign-key and check violations carry
     `constraint` and `table`). The field table in #3 is corrected; T08's errors body
     expects no `constraint` on a pg `NotNullViolationError`.
  2. The parameter rule's "plain object" is one whose prototype is `Object.prototype` or
     `null`. Any other object (`Map`, `Set`, a class instance, a typed array other than
     `Uint8Array`) is a `TypeError`, because `JSON.stringify` would turn a `Map` into
     `{}`. An invalid `Date` and a fragment passed as a parameter are `TypeError`s on both
     dialects. The rule is exported as `normalizeParam(value, dialect)` and
     `normalizeParams(params, dialect)`; `statementOf` stays a pure render/pass-through
     and the adapter applies the rule after it.
  3. SQLite's subject is read from the message as well as the message allows: a dotted
     table or column name is split at its first dot, and an unnamed `CHECK` whose whole
     expression is one identifier (`check (active)`) reads as a constraint of that name,
     since SQLite reports an unnamed check by its expression text.
  4. `SqlError`'s constructor refuses an unknown `kind` or dialect with a `TypeError`;
     each class's `name` is set on its prototype.
- **D27** (2026-11-18, T05 session) — Found while building the single-connection core
  and the node:sqlite adapter; open to veto at T12 ([02](./02-adapters.md) #2).
  1. A statement that returns no columns reports SQLite's `changes`, which DDL does not
     reset: on Node 26.13.1 a `create table` after a two-row insert reports `rowCount` 2.
     R2 promises a count for `SELECT`, a plain write and `RETURNING` only, and the `driver`
     body asserts nothing for DDL. F10 found the same on Durable Objects. T12 decides
     whether a non-write's `rowCount` is promised (a `total_changes()` delta would make it
     0, at two extra statements per write). **Settled by D34.2: not promised.**
  2. The core derives `capabilities.crossProcessLock` from the backend having `lock`, and
     sets `concurrentWriters` false. Outside a transaction it calls `lock(name, false)`, and
     the release, in the connection's turn, after the in-process queue for that name:
     while a lock is being waited for, nothing else runs on that connection (T15's
     `pg.Client` polls there). Inside one it calls `lock(name, true)` once per holder.
     Pinned against a stub backend in `test/unit/single-backend.test.ts`.
  3. `classify` is on the seam but not yet applied: wrapping errors is T08's.
  4. node:sqlite: a read-only transaction reads `query_only` first and leaves a handle the
     host made query-only so; rows are objects even on a handle opened with
     `returnArrays`; `close()` does not close a handle the host already closed; WAL is
     decided by `db.location()` (null for a database that is not a file), not by a path
     pattern. `close()` inside a transaction is a `TypeError`, since it would queue behind
     the transaction that awaits it.
- **D28** (2026-11-18, T06 session) — Found while building the sync tier; open to veto at
  T12 ([02](./02-adapters.md) #3).
  1. S5 covers every async entry point, `exclusive` and `close` as well as `query`, `exec`
     and `transaction`: from a sync callback each could only run after it returned.
  2. S4's "open" lasts until the backend has committed or rolled back, not only until
     the async callback settled: in between, the connection is still inside the
     transaction. Pinned on a stub backend in `test/unit/single-backend.test.ts`.
  3. "Inside a sync transaction" is a counter, not an `AsyncLocalStorage` mark as 02 #3's
     note suggested: the callback is synchronous, so whatever runs while the counter is
     up runs within it, a function bound to another context included.
  4. S1: when the callback answered a native `Promise`, its rejection is marked handled,
     so the `TypeError` is the one failure reported. A thenable that is not a `Promise`
     is left untouched: calling its `then` may start work.
  5. A sync call's own database error is thrown as the engine raised it; T08's wrapping
     at the boundary applies to the sync tier too.
  6. `AdapterCase.sync` is required: T07 and later rows state it, and the `sync` body
     holds an adapter marked `false` to having no tier.

- **D29** (2026-11-18, T07 session) — Found while porting the pool adapter; open to veto
  at T12 ([02](./02-adapters.md) #4).
  1. The structural types are `PgPoolLike` (`connect`, `end`, `on`, `listenerCount`),
     `PgPoolClientLike` (`query`, `release`) and `PgClientLike` (`query` only), not one
     `PgClientLike` carrying `release`: a `pg.Client` has no `release`, so T15 extends
     `PgClientLike` with `end` instead of fighting a member it lacks. `PgDriverOptions`
     lives in `src/pg/types.ts`, where T15's `client.ts` can share it.
  2. A `COMMIT` answered with `ROLLBACK` still rejects with the snapshot's plain `Error`
     ("answered COMMIT with ROLLBACK"); T08 makes it `TransactionAbortedError` and updates
     `test/pg/transaction-pinning.test.ts` with it.
  3. `query()` with no parameters goes out as a simple query, so a text of several
     statements runs them all and node-postgres answers an array. The adapter then
     rejects with a `TypeError` naming `exec()`, after the statements ran. node:sqlite runs
     only the first statement of such a text, silently. T12 decides whether the contract
     says more (forcing the extended protocol on `pg` would refuse it before anything ran).
     **Changed by D34.1: refused before any of it runs, on both (R11).**
  4. `close()` inside a transaction or an `exclusive` section rejects with a `TypeError`,
     as on the single-connection core (D27.4): `pool.end()` waits for the pinned
     connection, which is released only after the callback that awaits it.
  5. `pnpm run test:pg` and `test:sqlite` read `test/conformance/` and the adapter's own
     directory, not the whole tree. Under a name filter that leaves a file with no test,
     Node 26.13.1 runs its root-level `after` before its async root `before` resolved, so
     `test/do/probe.test.ts` started workerd and never disposed it, and the run hung. A
     later adapter's own suites go in `test/<adapter>/`, named `<adapter>/<topic>`.
  6. The pg-only suites take a schema per case (D20), where the snapshot shared one per
     file; `test/_env.ts` requires `TEST_PG_DATABASE` only, and leaves an unset user or
     password to node-postgres's own defaults.

- **D30** (2026-11-18, T08 session) — Found while wrapping errors at the boundary; open to
  veto at T12 ([01](./01-core.md) #4).
  1. A `TypeError` is never wrapped, from the driver or from a backend: D17 makes a
     programming mistake a `TypeError`, and a backend refuses with one of its own (T15's
     `pg.Client` backend will refuse a text of several statements, as the pool does,
     through the core; since D34.1 the server refuses it first, on the extended protocol). Every other thrown value is wrapped, Node's own errors included:
     node:sqlite's `database is not open` and node-postgres's `Cannot use a pool after
     calling end` are `SqlError`s of kind `unknown`.
  2. The single-connection core tells a callback's error from the backend's by identity:
     what the callback threw (boxed, so a thrown `undefined` counts) comes out of
     `backend.transaction` as it was; anything else from it (a failed `BEGIN` or
     `COMMIT`) is wrapped. The core also wraps a backend lock's taking and release and
     `close()`, pinned on a stub in `test/unit/single-backend.test.ts`. The pool adapter
     needs no such test: its guard is around each node-postgres call (`send`,
     `pool.connect`, `pool.end`), and a callback never runs inside one.
  3. A `COMMIT` answered with `ROLLBACK` is a `TransactionAbortedError` with no `code` and
     no `cause`: the server sent no error, only the command tag.
  4. `openSqlite` wraps opening the file and setting WAL, node:sqlite's "connecting": a
     file that cannot be opened is a `SqlError` of kind `unknown`, code `"14"`
     (`SQLITE_CANTOPEN` has no kind of its own).
  5. The `errors` body asserts 01 #3's field table exactly, a field the table does not
     promise asserted absent, and checks `cause` by classifying it again. It sets up its
     schema with `exec()`. T19 has to make it pass on Durable Objects, whose errors carry
     no `errcode` (F11).
  6. The pg-only deadlock case takes about one second: `deadlock_timeout` is
     superuser-only, and the test role is not one. The suite also pins node-postgres's
     real `timeout exceeded when trying to connect` against the classifier, on a pool of
     one held by a transaction, and a lock refused by `lock_timeout` as `BusyError`.
  7. The `catch` guard in `test/unit/core-imports.test.ts` reads code only (comments,
     strings, templates and regular expressions blanked; one bare word in a string kept,
     as `"code"` is how a read by name is spelled) and flags a property read, a read by
     name and destructuring, in a `catch` clause or a `.catch(…)` call.

- **D31** (2026-11-18, T09 session) — Found while writing the statement builders; open to
  veto at T12 ([03](./03-conventions.md) #1).
  1. Rule 1 holds in a match too: an `undefined` key is left out of `whereEq` and of an
     `update`/`deleteFrom` match, which widens it (`deleteFrom("t", { tenant, id })` with
     `id` undefined deletes the tenant's rows). Kept as written, since a filter built from
     optional inputs wants it; the module comment says so. A match left with nothing is
     still a `TypeError` (rule 2). **Changed by D34.3 for `update` and `deleteFrom`.**
  2. "Empty" in rules 4 and 6, and for a fragment given as the table, is a fragment with no
     value and no text but whitespace, not `EMPTY` by identity: `raw("")`, `raw(" ")` and
     `and()` count.
  3. `upsert` takes one row (an array is a `TypeError`) and a non-empty `conflict` list:
     Postgres needs a target for `do update`, and the shared subset keeps it for
     `do nothing` too. An `update` column need not be one the row writes (its
     `excluded` value is then the column's default, a real `updated_at` idiom). A default
     `update` with no column left renders `do nothing`, as `update: []` does.
  4. `returning` is `"*"` or a non-empty array of names; `[]` and any other string are a
     `TypeError`. An options argument that is not an object is one too.
  5. `inList` binds an `undefined` element as any value (`NULL` by the parameter rule):
     rule 1 is about keys. A fragment element is spliced.
  6. The root entry point exports the types `TableRef`, `Returning` and `Match` beside
     the builders, since they appear in the builders' signatures.
  7. The `builders` body also runs the fragments through the sync tier on an adapter that
     has one, since the module comment promises both tiers.

- **D32** (2026-11-18, T10 session) — Found while writing the decoders; open to veto at
  T12 ([03](./03-conventions.md) #5).
  1. `decodeRow` and `decodeRows` refuse a column the spec names that the row does not
     have, with a `TypeError`, rather than letting the decoder read its `undefined` as
     `null`: a driver hands back every column it selected, so a missing one is a spec that
     does not match its query, and a misspelt name would otherwise decode to `null`
     silently. The decoders themselves still read `undefined` as `null`, as the table says,
     for use on one value. An inherited property is not a column.
  2. A refusal names the column and the type it found, never the value: a column holds
     data, and an error message is what reaches a log. So `json`'s refusal carries no
     `cause`, since the parser's `SyntaxError` quotes the text. A decoder called without a
     column name says "the value".
  3. `number`'s numeric string is decimal text: digits with an optional sign, fraction and
     exponent. Whitespace, hex, `"NaN"` and `"Infinity"` are refused (`Number()` alone
     reads `""` as 0 and `"0x10"` as 16). A `bigint` outside ±(2^53−1) is refused with a
     pointer to `decode.bigint`. `bigint`'s integer `number` need not be safe:
     `BigInt(2 ** 60)` is exact for the number it is given. `bool` compares strictly and
     case-sensitively.
  4. `instant` returns a valid `Date` as it is, not a copy, and refuses a `bigint` (the
     table names a number). A string is read as `Date` reads it, so a date and time with
     no offset is local time, which is how SQLite's `CURRENT_TIMESTAMP` writes UTC. Kept
     as written and stated in the module comment; T12 decides whether `instant` reads that
     form as UTC. **Changed by D34.4: it does.**
  5. `json` parses every string, so on `pg`, where a `json`/`jsonb` column arrives parsed,
     a column whose JSON value is itself a string is parsed a second time (`"12"` becomes
     `12`; `"hello"` is a `TypeError`). Stated in the module comment: it is for columns of
     objects and arrays. T12 decides whether a decoder should know the dialect.
     **Confirmed by D34.5: it does not.**
  6. `decode` is frozen. The signatures keep the plan's inline
     `Row & { [K in keyof S]: ReturnType<S[K]> }`, with no named alias; `Decoder` is the
     one type exported beside the functions. The `decoders` body also round-trips a
     `bigint` (`bigint` on `pg`, `integer` on `sqlite`) and a fraction (`numeric(10, 2)`,
     `real`), pins on `sqlite` that the rows read back undecoded, and decodes rows from the
     sync tier on an adapter that has one.

- **D33** (2026-11-18, T11 session) — Found while writing retry and health; open to veto
  at T12 ([03](./03-conventions.md) #3).
  1. `fn` receives the number of the call, 1 for the first; `onRetry`'s `attempt` is the
     call that failed, so retry `n` follows attempt `n`. `onRetry` is called before the
     wait, as the prior implementation logged before it slept.
  2. A hook that throws (`retryable`, `onRetry`) ends the run with what it threw,
     untouched, as callback code always comes out here; the database error it was
     handed is not kept. A synchronous throw from `fn` counts as its rejection.
  3. The signal: one aborted already makes no call; aborting during a wait clears the
     timer and rejects with the signal's reason (an `AbortError` when none was given);
     a call in progress is not interrupted, its value still stands and an error it would
     not retry is still rethrown, but a retryable one ends the run with the reason,
     without `onRetry`.
  4. Options are checked before the first call, a wrong one a `TypeError` (a rejection,
     `withRetry` being async): `retries` a non-negative integer, the delays from 0 to
     2^31 − 1 ms (`setTimeout` fires a longer wait at once), `factor` finite and at least
     1, hooks functions, `signal` an object with `addEventListener`. A first wait above
     `maxDelayMs` is cut to it.
  5. `checkHealth` reports a rejection that is not a `SqlError` (a `TypeError` from a
     refused call, a raw error from a driver that does not wrap) as one, classified for
     the driver's dialect, with the original as `cause`; a thrown value that cannot even
     be read is a `SqlError` of kind `unknown`. So it never rejects, which the monitor
     relies on: a rejection there would be unhandled. A `db` that is not a driver (no
     `query`, or a dialect not known) is a `TypeError` thrown at the call.
  6. `latencyMs` is `performance.now()`'s, fractional and monotonic, and `null` when the
     check failed (the prior implementation timed failures too, so a connection timeout
     read as latency). `checkedAt` is when the check was sent.
  7. `onChange` is called with the first status and a `previous` of `null`, as its type
     allows, then only on a flip; `previous` is the check before, a repeat included.
     `last()` is set before `onChange` runs and kept across `stop()`, so a restart whose
     first status did not flip calls nothing. A check in progress at `stop()` (or from a
     run since restarted) is dropped: not reported, nothing scheduled. `start()` while
     running answers that run's first check.
  8. `intervalMs` is above 0 and at most 2^31 − 1; the next check starts that long after
     the previous one settled, so checks never overlap. A check has no timeout of its
     own: one that never answers holds the monitor, bounded only by the driver's own
     timeouts. T12 decides whether `checkHealth` takes a `timeoutMs`. **Changed by D34.6:
     it does, in row T33.**
  9. The `driver` body has two health cases: a live driver is healthy, and a closed one is
     unhealthy with a `SqlError` of its dialect, the check still resolving.

- **D34** (2026-11-18, T12; the owner delegated the review to the reviewing session) —
  The API was used as a host would use it, by a script on node:sqlite and on Postgres:
  `sql`, `ident`, `json`, `raw`, `query`, `exec`, a nested and a rolled-back
  `transaction`, a read-only one, `exclusive`, `db.sync`, every builder, the decoders,
  `withRetry` and `checkHealth`. `DO-FINDINGS.md` was read in full. **D09–D24 stand as
  written, D24 included**: `nodejs_compat` alone gave `AsyncLocalStorage` and
  `node:assert/strict` (F05, F06). D25–D33 stand except as changed here. The open points
  they left, and the four `DO-FINDINGS.md` hands to T12, are settled as follows.
  1. **R11: `query` runs one statement** (settles D29.3; changes what T05 and T07
     built). The script showed node:sqlite run the first statement of a text and drop
     the rest without a word, and the pool run them all, then refuse. Now a text of
     several is refused before any of it runs. node:sqlite: the adapter reads what
     follows the compiled statement's `sourceSQL`, and anything but blanks, `;` and
     comments is a `TypeError`. `pg`: `query()` goes on the extended protocol
     (`queryMode: "extended"`), with or without values, and the server refuses with
     `42601` "cannot insert multiple commands into a prepared statement", a `SqlError`
     of kind `unknown`; `CREATE INDEX CONCURRENTLY` and `VACUUM` still run that way.
     `PgClientLike.query` takes a config object (`PgQueryConfigLike`, exported). The
     `TypeError` after the fact stays only for a node-postgres that ignores
     `queryMode`. The `driver` body gains an R11 case; T15 and T16 must pass it; T19
     follows 02 #7.
  2. **A non-write's `rowCount` is not promised** (settles D27.1). It is a number and
     nothing more: no caller branches on what DDL counted, and a `total_changes()`
     delta costs two statements per write. `QueryResult`'s doc says so.
  3. **The match of `update` and `deleteFrom` refuses `undefined`** (changes D31.1). The
     script's `deleteFrom("job", { tenant: "z", id })` with `id` undefined deleted every
     row of the tenant, and a module comment was all that warned of it. Widening a write
     loses data, so the match object of these two throws a `TypeError` naming the key.
     `whereEq` still drops it, as a read's optional filter wants, and passing
     `whereEq(match)` as the `where` is how a write says dropping is meant.
  4. **`decode.instant` reads a date and time with no offset as UTC** (changes D32.4).
     The script decoded SQLite's `current_timestamp` an hour early on a host in CET.
     SQLite's date and time functions write UTC with no offset, so
     `YYYY-MM-DD[ T]HH:MM[:SS[.fff…]]` is read as UTC; any other string as `Date` reads
     it. Pinned in `test/unit/decode.test.ts` under a +05:45 zone, since CI's zone is
     UTC and would hide it, and by a `decoders` case on a time the database wrote.
  5. **`decode.json` stays blind to the dialect** (confirms D32.5). A `jsonb` value that
     is itself a string is rare and stated; knowing the dialect would put it in every
     spec.
  6. **`checkHealth` takes a timeout** (settles D33.8), in new row T33, spec in
     [03](./03-conventions.md) #6. A check that never answers left `last()` at the
     previous status, healthy during an outage, and node-postgres's pool waits for a
     connection without limit by default (`connectionTimeoutMillis` 0).
  7. **Durable Objects, for T19** (the four points of `DO-FINDINGS.md`; 02 #7 has the
     detail).
     1. *Read-only* is enforced by detection, not refused: in a read-only transaction a
        statement whose cursor reports `rowsWritten > 0` is a `ReadOnlyError`, and the
        backend's transaction throws again after the callback, inside
        `storage.transaction` or `transactionSync`, so the write rolls back whatever the
        callback did with the error. The snapshot half of R7 holds by itself: an open
        async transaction keeps every other request out (F14). If T19 finds a read (a
        sort or a `group by` included) reporting rows written, `readOnly` is allowed
        unenforced and R7's write case is listed under `except` with F12 as the reason.
        Never a `TypeError`: it would fail correct portable code on one adapter.
     2. *`bigint`*: the parameter rule is unchanged, since node:sqlite binds a 64-bit
        `bigint` exactly. The Durable Objects backend turns one in the safe-integer
        range into a number and refuses any other with a `TypeError` naming F09.
     3. *Blobs* read back as a `Uint8Array` on every adapter. R10 says so from T12, and
        a `driver` case holds node:sqlite and Postgres to it; node-postgres's `Buffer` is
        a `Uint8Array` already. The Durable Objects backend wraps workerd's
        `ArrayBuffer` in a view.
     4. *Errors*: `classifySqlite` learns to read the extended code name from the
        `(extended: SQLITE_…)` suffix, and to strip the `: SQLITE_…` tail before reading
        the subject, when an error has no `errcode`. One classifier per dialect, not one
        per adapter: `checkHealth` classifies by dialect alone.
  8. **A correction to F12**: node:sqlite enforces foreign keys by default
     (`DatabaseSync`'s `enableForeignKeyConstraints` is true; probed on Node 26.13.1),
     so every adapter enforces them and F12's contrast with "node:sqlite's default
     (off)" was wrong. D23 stands: `openSqlite` sets nothing more.

- **D35** (2026-11-18, T13 session) — Found while wiring `@marianmeres/migrate` over a
  `Driver`; open to veto ([03](./03-conventions.md) #2).
  1. pnpm's release-age gate refused `@marianmeres/migrate@2.0.0` and also
     `@marianmeres/semver@1.0.1`, published the same day and required by it (`^1.0.1`).
     Both are excluded at their exact versions in `pnpm-workspace.yaml`, with a comment. The
     lockfile now names `@marianmeres/pubsub` and `@marianmeres/searchable` (public, through
     `item-collection`), so the public-clean allowlist gains both.
  2. No "inside a run" flag. `getActiveVersion` checks that the table exists on every read,
     in a run too (one statement), and a step's `setActiveVersion` runs the
     `create table if not exists` again inside the step's transaction (a no-op). A flag on
     the instance is blind to async context: on a pool, a `setActiveVersion()` from outside a
     run in progress would see it set and skip the lock.
  3. `createMigrate` refuses with a `TypeError`: a `db` not shaped like a driver, an
     `options` that is not an object, a `table` that is not a string matching the package's
     pattern (`null` included: the package's `??` takes `null` as the default), a `context`
     that is not an object (an array included), a `logger` that is not a function.
  4. A worker receives `{ ...context, db }`: `db` wins over an extra key of that name, as
     the package's helpers do. `MigrateOptions` keeps the plan's
     `Record<string, unknown>` bound on `TExtra`.
  5. The interop suites pin the version table (Postgres: `information_schema.columns`;
     SQLite: the `sqlite_master` text, equal character for character) and the run lock both
     ways. On Postgres a run of either waits for the other, and a lock name other than
     `migrate:<table>` fails that case (checked by mutation). On SQLite the exclusion is
     shown with a busy timeout of 0, since a waiting handle would block the thread its
     holder needs: the helper's `BEGIN IMMEDIATE` is refused with `database is locked`, and
     `createMigrate`'s run with an `Error` whose `cause` is a `BusyError`.

- **D36** (2026-11-18, T14 session) — Found while loading SQL files as versions; open to
  veto ([03](./03-conventions.md) #4).
  1. Every refusal is a `TypeError` (a rejection, `addSqlFiles` being async), its message
     `addSqlFiles: <path>: <reason>`, the path the file's or, for an empty directory, the
     directory's. A missing directory rejects with the file system's own `ENOENT`, unwrapped.
  2. "One version" is semver precedence, not the normalized text: `1`, `1.0.0` and `01`
     are one version, and so are `1.0.0+a` and `1.0.0+b`, since `compareSemver` orders each
     pair as equal and the package would otherwise register both and order them by their
     text. A version the instance already has is refused too, checked after the reads
     with nothing awaited before the first registration, so a refusal registers nothing.
  3. An up and a down pair by version, not by label; the label is the up file's, handed
     to `addVersion` as the comment. The label is the text after the first `__` (a version
     holds no `_`), any characters, but not empty. The `.sql` test is case-insensitive, so
     `2.UP.SQL` is refused rather than silently ignored; the pattern itself is lowercase.
  4. Every file is read before the first version is registered, and the text is kept: a
     file changed afterwards is not read again. A leading byte-order mark is dropped:
     the test Postgres refuses one (`syntax error at or near "\uFEFFselect"`). node:sqlite
     accepts it, so the unit suite proves the strip through a recording `exec`.
  5. The signature is generic, `addSqlFiles<T extends MigrateContext>(migrate: Migrate<T>,
     dir)`, so an instance from `createMigrate` with extra context is taken as it is. The
     instance is checked by shape (`addVersion`, `available`), not `instanceof`, since the
     caller's copy of `@marianmeres/migrate` may not be this package's.
  6. `compareSemver`, `normalizeSemver` and `parseSemver` come from `@marianmeres/migrate`,
     which re-exports them: no new dependency. Any directory entry that is not a directory
     is considered, so a symbolic link to a file loads.

- **D37** (2026-11-18, T15 session) — Found while putting one `pg.Client` under the
  single-connection core; open to veto ([02](./02-adapters.md) #5).
  1. The client's type is `PgStandaloneClientLike`, which extends `PgClientLike` with `end`
     (D29.1) and with `on` and `listenerCount`: the driver listens to the client's `error`
     event as the pool driver listens to its pool's, since node-postgres emits one when an
     idle client's connection drops and an unlistened one ends the process. Quiet when the
     host listens; a warning otherwise. A `pg.Pool` is refused with a `TypeError` (it has a
     numeric `totalCount`): every statement of a "transaction" would take any connection.
  2. The core's count is of the transaction's state, not of failures. A failure sets it
     (the first of a run is the `cause`); a statement's success after one clears it, since
     on Postgres only a `rollback to savepoint` can succeed in an aborted transaction; a
     lock's success clears nothing (a backend may take one without a statement); a
     `TypeError` counts for neither. Without the clearing, a transaction recovered through
     a hand-written savepoint would be rolled back on `pg-client` and committed on the
     pool.
  3. Before deciding, the core waits for whatever the transaction's context sent and did
     not await. Otherwise a failing statement still in flight when the callback resolved
     is missed, and the `COMMIT` goes out.
  4. The client backend still checks the `COMMIT`'s command tag, as the pool does: a
     failure the core cannot see (the host's own statement on the same client) is
     otherwise a commit reported with nothing kept. The core's `TransactionAbortedError`
     carries the failure as `cause`; the tag's carries none (D30.3). R3's `pg` side in the
     `driver` body now asserts `TransactionAbortedError` of kind `aborted` on every `pg`
     adapter.
  5. The client backend sends one statement at a time, in order: node-postgres deprecates
     a second `query()` on a client still running one, which a callback's `Promise.all`
     inside a transaction would otherwise do. `options.schema` is set before the first
     statement, outside any transaction; a failed `set search_path` is tried again by the
     next statement.
  6. Shared with the pool driver, moved rather than copied: the lock to `src/pg/lock.ts`
     (as 02 #5 says) and `BEGIN_READ_ONLY`, the `COMMIT` refusal, the result reading and
     the `schema` option's check to `src/pg/session.ts`. The pool's messages are unchanged.
  7. The savepoint and not-awaited cases live in `test/pg/client.test.ts`, not in the
     `driver` body: a Durable Object refuses `SAVEPOINT` (F04), and the wait for statements
     not awaited is the single-connection core's, which the pool does not have.

- **D38** (2026-11-18, T16 session) — Found while putting PGlite under the single-connection
  core; open to veto ([02](./02-adapters.md) #6).
  1. `@electric-sql/pglite@0.5.16` passed pnpm's release-age gate with no exclusion. Its
     types and its source (read from the installed package's source maps) settled the
     section's two checks. **R11 holds by the server's refusal**: PGlite's `query` sends one
     statement on the extended protocol, and a text of several is refused with `42601`
     before any of it runs. **Its errors carry the SQLSTATE**: a `DatabaseError` with
     `code`, `constraint`, `table` and `column` named as node-postgres names them, so
     `classifyPg` reads them unchanged. `test/pglite/pglite.test.ts` pins both shapes.
  2. PGlite's `transaction` sends `BEGIN` and `COMMIT` itself and checks the `COMMIT`'s tag,
     throwing its own `TransactionAbortedError` (`25P02`) when it reads `ROLLBACK`. The
     core refuses to commit first, so a swallowed failure rejects with the core's
     `TransactionAbortedError` whose `cause` is the failed statement's error, and PGlite
     rolls back. PGlite's own `25P02` is classified `aborted` too, should it ever come out.
  3. The backend rethrows the callback's rejection when PGlite answers with a failed
     `ROLLBACK` instead, as the client backend keeps the cause over a failed `ROLLBACK`.
  4. `createPgliteDriver(db)` takes no options: PGlite is one database, and a `schema`
     option was not in the section. The structural shapes are exported: `PgliteLike`,
     `PgliteTransactionLike`, `PgliteResultsLike`. A value that lacks `query`, `exec`,
     `transaction` or `close` is a `TypeError`.
  5. `rowCount` follows the section (`fields.length > 0 ? rows.length : affectedRows ?? 0`),
     although PGlite 0.5 also answers a per-statement `rowCount`. For one statement the
     two agree.
  6. Values PGlite does differently from node-postgres, each documented in the module and
     none in conflict with a conformance body. PGlite serializes a parameter by the type
     the server inferred for its placeholder, where node-postgres serializes by the
     JavaScript value. So where the server infers `text`, an array binds as `1,2`, not
     `{1,2}`, and a `Date` as ISO text, not local time with an offset. An `int8` reads as a
     number while it is a safe integer and as a `bigint` beyond it; node-postgres reads it
     as a string. Cast the placeholder (`cast(${list} as integer[])`) and the two agree.
  7. Creating an instance runs `initdb` (about 0.6 s). The test fixture
     (`test/pglite/_fixture.ts`) dumps one fresh data directory per test process and loads
     each case's instance from it (about 0.1 s), so every case still gets an empty
     database of its own. `pnpm run test:pglite` selects the adapter's cases, as `test:pg`
     and `test:sqlite` do, and `^pg\b` does not match `pglite`.

## How to resume (for a fresh conversation)

1. Read this file, then `00-overview-and-roadmap.md` if you need the shape of the whole.
2. Pick the first ⬜ task whose `Deps` are all ✅ (or the `T##` you were given); open its
   source section for the detail and its **Done when**, and the decisions it cites.
3. Check `tmp/prior-art/` exists and read its `README.md`. Check the section's premise
   against the code as it is now.
4. Implement → add the tests the section names → `pnpm run ci` → set the row to ✅ with
   the commit → commit when the owner asks, or as the driver's prompt says.
