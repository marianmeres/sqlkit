# Durable Objects findings (T04 spike)

What a SQLite-backed Durable Object does with the calls the design relies on, observed in
real workerd. Source: [02](./02-adapters.md) #1. One entry per assumption (F01–F06 for
A1–A6) and per probe (F07–F14 for P1–P8).

**Observed on** workerd `1.20260730.1`, through Miniflare `4.20260730.0`, compatibility date
`2026-07-01`, compatibility flags `nodejs_compat` only, Node 26.13.1, macOS arm64, on
2026-11-18. The objects stored in memory (`durableObjectsPersist: false`).

**How to re-run:** `node --test test/do/probe.test.ts` (or `pnpm test`). The harness is
`test/do/_workerd.ts`, the object `test/do/worker/probe.ts`. Every answer below is pinned
there by an assertion, so a workerd upgrade that changes one fails that test: update the
entry here with the new version when it does.

## Verdict

**All six assumptions hold.** Nothing found blocks the single-connection core on Durable
Objects (02 #2) or the adapter (02 #7): transactions are callback-shaped (F04) and both
callback forms behave as the seam needs (F02, F03), `AsyncLocalStorage` carries its store
through the async transaction (F05), and the conformance bodies can assert inside workerd
(F06).

**D24 holds as far as T04 can tell:** `nodejs_compat` alone, on a 2026 compatibility date,
provides `node:async_hooks` and `node:assert/strict`. No other flag was needed.

**For T12** (decisions this spike feeds; none is taken here; T12 took all four, D34.7 in
`PROGRESS.md`, detail in 02 #7: read-only enforced by `rowsWritten` detection, a `bigint`
in the safe range bound as a number, blobs read back as a `Uint8Array`, and
`classifySqlite` reading the code from the message):

1. **Read-only transactions** (02, open questions): `PRAGMA query_only` is not authorized
   (F12), so R7's "refuses a write" cannot be enforced the way node:sqlite does it. The
   choice stays the one 02 names: refuse `readOnly: true` with a `TypeError`, or allow it
   unenforced.
2. **`bigint` parameters** (not foreseen by the plan): the parameter rule passes a `bigint`
   through on `sqlite`, and workerd refuses every `bigint` at the call, even `42n` (F09).
   Options: convert one in the safe-integer range to a number, refuse it with a `TypeError`
   before workerd sees it, or let workerd's error stand.
3. **Blobs read back as `ArrayBuffer`** (not foreseen by the plan): node:sqlite returns a
   `Uint8Array` for a blob, workerd an `ArrayBuffer` (F09). R10 says only "rows are plain
   objects". Whether the adapter converts is T19's to settle, or T12's if it should be a
   rule.
4. **Errors carry no code field** (F11): `classifySqlite` as written in T03 needs a numeric
   `errcode` and so reads every Durable Objects error as `unknown`. The extended code is in
   the message instead; T19's classifier (or a change to the SQLite one) reads it from
   there.

## Assumptions

### F01 — A1: `sql.exec()` is synchronous; a script without bindings runs every statement

**Holds.** `sql.exec()` returns a cursor, not a thenable. A four-statement script (two
`create table`, two `insert`, the second of two rows) had run completely by the next line,
with no `await` in between: both tables held their rows.

Consequence: the backend's `exec(script)` is `sql.exec(script)`, and the engine is
synchronous underneath, so a sync tier is possible (D03).

### F02 — A2: `transactionSync(fn)` returns `fn`'s value and rolls back when `fn` throws

**Holds.** It returned the very object `fn` returned (identity, not a copy). When `fn`
threw after an `insert`, the insert was undone and the same error object was rethrown.

Consequence: the sync tier's transaction is `storage.transactionSync`.

### F03 — A3: the async `transaction()` holds `sql.exec` writes across an `await`

**Holds.** Inside `await storage.transaction(async () => …)`, writes made before and after
an awaited 20 ms timer and an awaited microtask all committed together, and the closure's
value was returned. In a second transaction that wrote, awaited a timer, wrote again and
threw, both writes were visible inside, both were undone, and the same error object was
the rejection.

Consequence: the async tier's backend transaction is `storage.transaction(() => fn(…))`.

### F04 — A4: `BEGIN` and `SAVEPOINT` through `sql.exec` are refused

**Holds.** Each of `BEGIN`, `BEGIN TRANSACTION`, `BEGIN IMMEDIATE`, `BEGIN EXCLUSIVE`,
`SAVEPOINT sp`, `RELEASE sp`, `ROLLBACK TO sp`, `COMMIT`, `END` and `ROLLBACK` threw, all
with the same message:

> To execute a transaction, please use the state.storage.transaction() or
> state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT
> statements. The JavaScript API is safer because it will automatically roll back on
> exceptions, and because it interacts correctly with Durable Objects' automatic atomic
> write coalescing.

Consequence: callback-shaped transactions at the backend seam (D15) are required, not a
preference. A script given to `exec`, a migration file included, cannot contain its own
`BEGIN` / `COMMIT` on this adapter.

### F05 — A5: `AsyncLocalStorage` keeps its store inside the async transaction

**Holds** under `nodejs_compat`. A store entered with `run()` outside the transaction was
the store inside the closure, after an awaited timer, after an awaited microtask, and after
the transaction. A store entered with `run()` inside the closure survived a timer and a
microtask within it, and the outer store was back once that `run()` settled.

Consequence: D09's rule (a statement belongs to the transaction whose callback issued it,
carried by `AsyncLocalStorage`) works on Durable Objects.

### F06 — A6: `node:assert/strict` is importable

**Holds** under `nodejs_compat`. A failed `deepEqual` threw an `AssertionError` (`name`
`"AssertionError"`, `code` `"ERR_ASSERTION"`, `instanceof assert.AssertionError` true), and
`equal(1, "1")` threw, so it is the strict flavour.

Consequence: conformance bodies that use `node:assert/strict` can run inside workerd (T19).

## Probes

### F07 — P1: does `transactionSync` nest?

**Yes, as a savepoint.** A `transactionSync` inside another one ran; when it returned, its
write committed with the outer one. When the inner one threw, only its own write was
undone: the outer callback caught the error, wrote again and returned, and its writes
before and after the inner call committed.

Consequence: none for v0, since the core joins a nested transaction itself (R4). It is what
savepoints (T26) could use on this adapter.

### F08 — P2: does the async `transaction()` nest?

**Yes, as a savepoint**, exactly as F07: an awaited inner `transaction()` that resolved
committed with the outer one; one that rejected undid only its own write, and the outer
closure caught the rejection, continued and committed.

### F09 — P3: which values bind, and as what?

Each value was bound twice into `select ? as v, typeof(?) as t`:

| Value                         | Binds | SQLite type | Reads back as                                                    |
| ----------------------------- | ----- | ----------- | ---------------------------------------------------------------- |
| `null`                        | yes   | `null`      | `null`                                                           |
| `undefined`                   | yes   | `null`      | `null`                                                           |
| `"text"`                      | yes   | `text`      | the string                                                       |
| `42`                          | yes   | `real`      | `42`                                                             |
| `1.5`                         | yes   | `real`      | `1.5`                                                            |
| `2 ** 53 + 2`                 | yes   | `real`      | `9007199254740994`                                               |
| `true` / `false`              | yes   | `text`      | `"true"` / `"false"`                                             |
| `new Date(…)`                 | yes   | `text`      | `Date.prototype.toString()`: `"Fri Jan 02 2026 03:04:05 GMT+0000 (Coordinated Universal Time)"` |
| `42n`, `2n ** 63n - 1n`       | no    | —           | throws `Cannot convert a BigInt value to a number`               |
| `Uint8Array [1, 2, 3]`        | yes   | `blob`      | an `ArrayBuffer` of the same bytes                               |
| `ArrayBuffer [1, 2, 3]`       | yes   | `blob`      | an `ArrayBuffer` of the same bytes                               |
| `{ a: 1 }`                    | yes   | `text`      | `"[object Object]"`                                              |
| `[1, 2]`                      | yes   | `text`      | `"1,2"`                                                          |

Every JS number binds as `real`, a whole one too; node:sqlite on Node 26.13.1 does the same
(`typeof(?)` of `42` is `real` there as well). An `integer` column stores a bound `42` as
`integer`, and `limit ?` accepts it.

Consequence: workerd coerces silently where node:sqlite refuses or differs, so the
parameter rule (D14) must run before `sql.exec`, as planned: it turns a boolean into
`1`/`0`, a `Date` into ISO text, a plain object into JSON text and refuses an array, which
workerd would otherwise bind as `"true"`, `toString()`, `"[object Object]"` and `"1,2"`.
`bigint` and the blob read type are open points for T12 (above).

### F10 — P4: how is the affected-row count obtained?

**`select changes()` right after the write; not `rowsWritten`.** On a table without an
index, `rowsWritten` equalled the rows affected. On a table with one index it counted index
writes too: 6 for a three-row `insert`, 4 for a two-row `update` of the indexed column, 6
for a three-row `update … returning`. `changes()` gave 3, 2 and 3 on both tables. A
`create table` reported `rowsWritten` 2 (the catalog), and `changes()` there and after a
`select` still reported the previous write's count. `rowsWritten` was the same before and
after the cursor was read, including for `update … returning`, so the statement had run to
completion when `sql.exec()` returned.

Consequence: the backend computes `rowCount` as the number of rows for a statement that
returns columns (`cursor.columnNames.length > 0`), and as `changes()` read immediately after
a statement that returns none, which is safe because nothing can run between two
synchronous calls. `changes()` is only meaningful after a write: a `select` or DDL leaves
it unchanged.

### F11 — P5: what does a constraint violation's error carry?

**A plain `Error` with a message and nothing else**: `name` `"Error"`, constructor `Error`,
own properties `message` and `stack` only; no `code`, `errcode` or `cause`. The SQLite
result codes are appended to the message:

| Violation   | Message                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| unique      | `UNIQUE constraint failed: child.code: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)` |
| foreign key | `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`    |
| not null    | `NOT NULL constraint failed: child.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)` |
| check       | `CHECK constraint failed: qty_positive: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)` |
| syntax      | `near "selec": syntax error at offset 0: SQLITE_ERROR`                                          |

The unique column carried a named constraint (`child_code_unique`); the message names the
column, not the constraint, which is SQLite's own wording. The check is reported by its
name.

Consequence: a classifier for this adapter reads the extended code name from the
`(extended: …)` suffix and strips `: SQLITE_…` before parsing the subject as the SQLite
classifier does. See point 4 for T12.

### F12 — P6: are `PRAGMA query_only` and `PRAGMA foreign_keys` permitted?

- **Foreign keys are on and stay on.** `PRAGMA foreign_keys` reads `1` and an orphan row is
  refused by default. `PRAGMA foreign_keys = OFF` is accepted without an error but changes
  nothing: the pragma still reads `1` and an orphan is still refused. `= ON` and
  `PRAGMA defer_foreign_keys = ON` are accepted too (the effect of the latter was not
  probed).
- **`PRAGMA query_only` is not authorized**, to read or to set: each form throws
  `not authorized: SQLITE_AUTH`, and a write after the attempt succeeds.

Consequence: a read-only transaction cannot be enforced with `query_only` here; point 1 for
T12. Foreign keys cannot be switched off on this adapter. (Corrected at T12, D34.8: this
first said node:sqlite's default is off. It is on: `DatabaseSync` enforces foreign keys
unless opened with `enableForeignKeyConstraints: false`, so every adapter enforces them.)

### F13 — P7: `sqlite_version()`, `RETURNING`, `ON CONFLICT`

- **`sqlite_version()` is not authorized**: `not authorized to use function:
  sqlite_version at offset 7: SQLITE_ERROR`. The version is bounded instead by functions
  that arrived in a known release: `->>` and `unixepoch()` (3.38.0), `concat()` (3.44.0)
  and `jsonb()` (3.45.0) work; `json_pretty()` (3.46.0) exists but is not authorized (the
  error is "not authorized", not "no such function"); `unistr()` (3.50.0) is "no such
  function". So **3.46.0 ≤ version < 3.50.0**. The release each function arrived in is
  from SQLite's release history and was not re-checked against it in this session.
- **`INSERT … RETURNING` works**, and so do `ON CONFLICT (k) DO NOTHING RETURNING` (no
  rows when the conflict hits) and `ON CONFLICT (k) DO UPDATE SET v = excluded.v
  RETURNING`.

Consequence: the adapter cannot assert a version floor at runtime (D23 asserts none
anyway), and the statement builders' `upsert` and `RETURNING` are usable here.

### F14 — P8: while an async transaction awaits a timer, does a second request run inside it?

**No: the second request waits until the transaction has settled.** Request A opened
`storage.transaction()`, inserted a row, awaited an 800 ms timer, and threw to roll back.
Request B, sent to the same object 200 ms after A, ran only after A's transaction had
finished: it saw no rows (A's row was rolled back), and its own insert survived A's
rollback, so it was not inside A's transaction. A's view after the timer held only its
own row. The responses came back A first, then B.

The control, the same two requests with A's timer outside any transaction, interleaved: B
ran while A awaited the timer, saw A's row, and A saw B's row after the timer.

Consequence: workerd itself keeps another request out of an open async transaction, even
one that awaits something other than storage. The probe did not cover a statement issued
during the transaction by the same request from outside the transaction's callback (a
promise started before it); that is the case the core's queue and context (R5, D09) exist
for, and they apply here unchanged. The cost the adapter's docs must state (02 #7) is
confirmed: an async transaction that awaits anything holds the whole object for that long.
