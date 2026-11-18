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
started again after the owner ticks it. No `Options:` line: eighteen machine rows in two
runs of ten and eight fit the driver's defaults (`sprint -h` prints them). Rehearse with
`sprint docs/plans/v0-foundation --dry-run`.

| Status | ID  | Deps | Task | Source | Decisions | Commit |
| ------ | --- | ---- | ---- | ------ | --------- | ------ |
| ✅ | T01 | — | Owner pre-flight: scaffold, `.claude/settings.json`, test database and `.env`, first commit on `master` | [04](./04-scaffold-docs-release.md) #1 | D02 D20 D21 | — |
| ✅ | T02 | T01 | `sql` fragments: `sql`, `raw`, `bind`, `join`, `ident`, `json`, `render`; the core-imports guard | [01](./01-core.md) #1 | D02 D21 | — |
| ✅ | T03 | T02 | Contract types, the parameter rule, `SqlError` classes, the pg and sqlite classifiers | [01](./01-core.md) #2, #3 | D07 D10 D11 D14 D17 | — |
| ✅ | T04 | T03 | Durable Objects spike: workerd harness under `node:test`, assumptions A1–A6, probes P1–P8, `DO-FINDINGS.md` | [02](./02-adapters.md) #1 | D03 D05 D20 D24 | — |
| ✅ | T05 | T04 | Single-connection driver core, the node:sqlite adapter (async tier), the runner-agnostic conformance harness and the `driver` body | [02](./02-adapters.md) #2 | D09 D12 D13 D15 D20 D23 | — |
| ✅ | T06 | T05 | Sync tier on node:sqlite and the tier rules S1–S6; the `sync` conformance body | [02](./02-adapters.md) #3 | D03 D16 | — |
| ✅ | T07 | T06 | Postgres pool adapter: pinned transactions, `exclusive`, `schema`; the `pg` fixtures and pg-only suites | [02](./02-adapters.md) #4 | D09 D12 D13 D20 | — |
| ⬜ | T08 | T07 | Typed errors end to end: adapters wrap at the boundary; the `errors` body and the adapter-specific error suites | [01](./01-core.md) #4 | D07 D17 | — |
| ⬜ | T09 | T08 | Statement builders: `insert`, `update`, `upsert`, `deleteFrom`, `whereEq`, `and`, `or`, `inList` | [03](./03-conventions.md) #1 | D08 | — |
| ⬜ | T10 | T09 | Explicit row decoders: `decode.*`, `decodeRow`, `decodeRows` | [03](./03-conventions.md) #5 | D08 | — |
| ⬜ | T11 | T10 | `withRetry`, `checkHealth`, `createHealthMonitor` | [03](./03-conventions.md) #3 | D08 D17 | — |
| 🔒 | T12 | T02 T03 T04 T05 T06 T07 T08 T09 T10 T11 | Owner review of the API and of `DO-FINDINGS.md`; D09–D24 confirmed or changed | [01](./01-core.md) #5 | D09 D10 D11 D14 D15 D16 D17 D24 | — |
| ⬜ | T13 | T12 | Migrate wiring over a `Driver` (`./migrate`), its conformance body, the interop tests | [03](./03-conventions.md) #2 | D06 D18 D21 | — |
| ⬜ | T14 | T13 | SQL files as versions (`./migrate/files`) | [03](./03-conventions.md) #4 | D06 D19 | — |
| ⬜ | T15 | T14 | `createPgClientDriver`: one `pg.Client` as a single-connection backend; aborted-transaction tracking in the core | [02](./02-adapters.md) #5 | D08 D15 | — |
| ⬜ | T16 | T15 | PGlite adapter (`./pglite`) | [02](./02-adapters.md) #6 | D05 D15 | — |
| ⬜ | T17 | T16 | Agent docs: `AGENTS.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/conventions.md`, `docs/tasks.md`, `mcp-include.txt`; the docs-links test | [04](./04-scaffold-docs-release.md) #2 | D02 | — |
| ⬜ | T18 | T17 | Human docs: `README.md`, `API.md`; the api-docs and exports tests | [04](./04-scaffold-docs-release.md) #3 | D02 D22 | — |
| ⬜ | T19 | T18 | Durable Objects adapter (`./do`): both tiers, every conformance body run inside workerd | [02](./02-adapters.md) #7 | D05 D16 D24 | — |
| ⬜ | T20 | T19 | Archive this plan set; copy the backlog to `docs/backlog.md` | [04](./04-scaffold-docs-release.md) #4 | D22 | — |

Row order is run order. T19 comes after the docs rows on purpose: if it blocks, the
package is documented and releasable without `./do`. The release is not a row (D22).

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
     0, at two extra statements per write).
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

## How to resume (for a fresh conversation)

1. Read this file, then `00-overview-and-roadmap.md` if you need the shape of the whole.
2. Pick the first ⬜ task whose `Deps` are all ✅ (or the `T##` you were given); open its
   source section for the detail and its **Done when**, and the decisions it cites.
3. Check `tmp/prior-art/` exists and read its `README.md`. Check the section's premise
   against the code as it is now.
4. Implement → add the tests the section names → `pnpm run ci` → set the row to ✅ with
   the commit → commit when the owner asks, or as the driver's prompt says.
