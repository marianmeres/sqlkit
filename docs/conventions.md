# Conventions

## File Organisation

- One subpath export per entry point: `src/mod.ts` is `"."`, `src/<adapter>/mod.ts` is
  `"./<adapter>"`, `src/migrate/files.ts` is `"./migrate/files"`. `package.json`'s
  `exports` maps each to `dist/`.
- `src/core/` is the runtime-neutral core; `src/single/` the single-connection driver
  core; an adapter's files live in its own directory.
- Every module opens with a header doc comment: purpose, invariants, what it imports.
- Tests:

  | Directory                                  | Holds                                                            |
  | ------------------------------------------ | ---------------------------------------------------------------- |
  | `test/unit/`                               | no database: pure functions, stub backends, the guards           |
  | `test/conformance/`                        | the bodies, their `*.test.ts` binders, the harness, the registry |
  | `test/pg/`, `test/pglite/`, `test/sqlite/` | one adapter's own suites and its `_fixture.ts`                   |
  | `test/do/`                                 | the workerd harness, the probe, the `do` adapter's suites        |

- A file whose name starts with `_` is a helper, not a test (`test/_env.ts`,
  `test/conformance/_suite.ts`).

## Naming

- Factories: `create<Name>Driver`; `openSqlite` is the one convenience that opens a client.
- Structural client shapes: `<Name>Like` (`PgPoolLike`, `PgliteLike`).
- `Driver.adapter`: `"node:sqlite"`, `"pg"`, `"pg-client"`, `"pglite"`, `"durable-objects"`.
- Suites: a conformance body's cases run under `describe(<adapter name>)` and start with
  their rule (`R7: …`, `S4: …`, `errors: …`, `builders: …`). An adapter's own suite is
  `<adapter>/<topic>` (`pg/exclusive`); a unit suite `unit/<topic>`. The `test:pg`,
  `test:pglite` and `test:sqlite` scripts select by these names; `test:do` runs
  `test/do/`.

## SQL

✅ Do: build statements from fragments; values are bound, never written into the text.

```ts
await db.query(sql`select * from ${ident("app", "job")} where tenant = ${tenant}`);
const where = and(whereEq({ tenant }), sql`id in ${inList(ids)}`);
```

❌ Don't: interpolate into text, or number placeholders by hand.

```ts
await db.query(`select * from job where tenant = '${tenant}'`);
await db.query(`select * from job where id = $1 and tenant = $2`, [id, tenant]);
```

- An identifier goes through `ident(...segments)`; a segment is never split on a dot.
- `raw(text)` is for SQL the code itself owns (`raw("now()")`), never caller input.
- `query` runs one statement; a script of several goes through `exec`.
- Composition is fragments in fragments: interpolating a fragment splices it.

## Parameters

One rule, applied by every adapter before any driver sees a value (`src/core/params.ts`):

| Value                                      | `pg`                     | `sqlite`                                |
| ------------------------------------------ | ------------------------ | --------------------------------------- |
| `undefined`, `null`                        | `NULL`                   | `NULL`                                  |
| `boolean`                                  | as is                    | `1` / `0`                               |
| `Date`                                     | as is                    | `toISOString()`                         |
| `bigint`, `number`, `string`, `Uint8Array` | as is                    | as is                                   |
| plain object                               | `JSON.stringify`         | `JSON.stringify`                        |
| array                                      | as is (a Postgres array) | `TypeError`: use `json()` or `inList()` |
| anything else                              | `TypeError`              | `TypeError`                             |

- A plain object has `Object.prototype` or `null` as its prototype; a `Map`, a class
  instance or another typed array is "anything else".
- `json(value)` binds JSON text on both dialects; it states the intent.
- An invalid `Date`, and a fragment passed as a parameter, are a `TypeError`.
- Reading back is opt-in, per column: `decodeRows(rows, { active: decode.bool, … })`.

## Error Handling

| Situation                             | Throw                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The database refused or failed        | a `SqlError` subclass, via `toSqlError` and the dialect's classifier, the driver's error as `cause` |
| The caller made a programming mistake | `TypeError`, never wrapped                                                                          |
| The caller's callback threw           | what it threw, untouched                                                                            |

✅ Do: branch on the class or on `kind`; retry on `retryable`.

```ts
try {
	await db.query(insert("user", row));
} catch (error) {
	if (error instanceof UniqueViolationError) return conflict(error.constraint);
	throw error;
}
```

❌ Don't: match driver codes or messages in an adapter's caller, or wrap a `TypeError`.

```ts
if (error.code === "23505" || /UNIQUE constraint failed/.test(error.message)) …
```

- A refusal on the async tier rejects; it never throws at the call (R1). On the sync tier
  it throws at the call.
- An error message names a column and a type, never a value: a value is data, and a
  message is what reaches a log.
- A field the database does not report (`constraint`, `table`, `columns`) is left
  undefined, not guessed.
- Recognize a `SqlError` with `instanceof`, never by its constructor or its prototype: an
  app may run two copies of the package, and `instanceof` is what reads the mark that
  makes one copy's error an instance of the other's classes.

## Patterns

- **Check inputs at the call.** An option of the wrong type or range is a `TypeError`
  before anything runs; validate eagerly, describe the value safely (type, not content).
- **Hold nothing.** Builders, decoders and fragments are pure; a driver holds the only
  state.
- **The host owns the client.** An adapter takes a client the host built, declares its
  shape structurally, and imports no driver library.
- **Hooks, not loggers.** `onRetry`, `onChange` and the migrate `logger` option are where a
  host logs; the package itself does not.

## Anti-Patterns

| Anti-pattern                                                                    | Instead                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `BEGIN` / `COMMIT` sent through `query`                                         | `db.transaction(fn)`                                                       |
| `SAVEPOINT` / `ROLLBACK TO` sent through `query`                                | `tx.savepoint(fn)`: it is undone for you, and runs on Durable Objects      |
| `withRetry` around part of a transaction                                        | around a whole `transaction` call or one idempotent statement              |
| A `try`/`catch` around a statement in a Postgres transaction, to go on after it | `tx.savepoint(fn)` around it: the failed statement aborted the transaction |
| Async work inside `db.sync.transaction`                                         | the async tier's `transaction`                                             |
| SQLite as a test stand-in for a Postgres app                                    | PGlite (`./pglite`)                                                        |
| A behaviour tested on one adapter only                                          | a case in a conformance body                                               |
| `import … from "pg"` (or any driver) under `src/`                               | a structural `<Name>Like` type                                             |

## Testing

- A behaviour of the contract is a case in a conformance body under `test/conformance/`,
  registered on a `Suite`, and runs on every adapter in `test/conformance/_adapters.ts`.
  A body imports no `node:test` (it is to run inside workerd too);
  `test/unit/conformance-imports.test.ts` checks it.
- Where the rule differs by dialect, the case says so and asserts each side
  (`db.dialect === "pg"`).
- An adapter-specific test lives in `test/<adapter>/`, and its header says why it cannot be
  a conformance case.
- A case that cannot hold on an adapter for a recorded reason about its database is listed
  under the registry entry's `except`, with that reason, and reported as skipped with it,
  never dropped. Only Durable Objects has any (`test/do/worker/conformance.ts`), each a
  finding of `DO-FINDINGS.md` pinned by `test/do/probe.test.ts`.
- Every case creates and disposes a database of its own: a fresh in-memory SQLite or PGlite,
  a fresh Postgres schema (`sqlkit_t_<random>`) dropped afterwards.
- Postgres is read from `TEST_PG_*` (`test/_env.ts`). Missing, it fails the suite; nothing
  is skipped to get to green.
- A server a test starts takes an OS-assigned port.
- No test waits forever: every test script passes `--test-timeout=60000`, so a case whose
  promise never settles (a gate nobody opened) fails after a minute. Without it the
  runner keeps waiting, and the gate with it. A case still opens its gates on every path:
  the timeout is the net, not the plan.
- A guard is tested on fabricated sources too, so a scan that finds nothing cannot pass.
- Assertions use `node:assert/strict`.

## Runtime and Tooling

- Node LTS is the runtime, the reference and the gate (`.node-version`; `engines.node`
  `^24.20.0 || >=26.6.0`: before 24.20, on 25 and before 26.6, node:sqlite misreads the
  columns of a statement SQLite recompiled after a schema change). Nothing is built,
  tested or documented for Deno or Bun.
- Erasable TypeScript only, run as written by Node: no `enum`, `namespace` or constructor
  parameter properties; `import type` for a type; relative imports end in `.ts`.
- `src/core/` and `src/mod.ts` import only `src/core/`: no `node:*`, no package.
  `src/single/` adds `node:async_hooks` and nothing else. `test/unit/core-imports.test.ts`
  checks both.
- No `https:`, `jsr:` or `npm:` specifiers. npm is the registry; no JSR.
- `@marianmeres/migrate` is the one runtime dependency. A database client is a dev
  dependency, for the tests.
- `pnpm run format` before committing; `pnpm run ci` must pass.

## Public-Clean

- The package is written to be public: no committed file (source, comments, tests, docs,
  the lockfile) names a private package. Earlier code is "the prior implementation".
- `test/unit/public-clean.test.ts` is a tripwire: every scoped name of the author's in a
  committable file must be on its allowlist of public packages. It does not catch a
  private package named in prose without its scope; the rule does.
