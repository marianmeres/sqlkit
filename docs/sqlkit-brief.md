# @marianmeres/sqlkit — Project Brief

> Status: design/discussion stage. This brief is input for implementation, not a final spec.

## Goal

A thin, convention-driven SQL toolkit that supports **PostgreSQL** and **SQLite** behind low-level adapters, with **one set of tooling and API shape**, while each application commits to **one dialect**.

It is a study project with real use in mind: production apps run on PostgreSQL, and SQLite is needed for Durable Objects, local-first/standalone tools and small apps.

## Core decision: same tooling, dialect-specific apps

- **Not** "write once, run on both". We do **not** target a lowest-common-denominator schema.
- Apps pick one dialect and may freely use dialect-specific SQL (jsonb, arrays, `timestamptz`, `ILIKE`, etc.).
- The library provides shared conventions, API shape, transactions, migrations and error handling, plus a small portable core where portability is real.

## Non-goals

- Not an ORM.
- Not a query builder competing with Kysely or Drizzle.
- SQL stays SQL. The library makes it safe, composable and transport-agnostic.

## Architecture (three layers)

### 1. Adapter contract

A minimal driver surface, roughly:

- `query` (rows), `exec` (no rows / affected count), `tx(fn)`, `close`
- **Capabilities descriptor**, e.g. `dialect`, `returning`, `jsonb`, `arrays`, `concurrentWriters`, `sync`

Planned adapters:

- PostgreSQL: `pg` and/or `postgres.js`
- PGlite (Postgres in WASM, for in-memory tests with real PG semantics)
- SQLite: `node:sqlite` (default, zero-dependency), `better-sqlite3`
- Cloudflare Durable Objects `SqlStorage`

### 2. SQL composition

- Tagged template literals: `` sql`select * from t where id = ${id}` ``
- Dialect-specific placeholder compilation (`$1` vs `?`)
- Identifier quoting helpers
- Safe fragment composition (nesting, joining, optional clauses)

### 3. Conventions

- Migrations runner (dialect-aware, plain SQL files)
- Pragmatic table/repository helper (thin, no ORM semantics)
- Type mapping, mostly for SQLite pain points: booleans, dates, JSON
- **Error normalization**: unique violation, FK violation, not-null, check, etc. become typed library errors instead of driver-specific codes

## Key design constraints

### Sync vs async

- SQLite drivers (`node:sqlite`, better-sqlite3, DO `SqlStorage`) are synchronous. Postgres drivers are async.
- Public API is async across the board.
- **Durable Objects:** `transactionSync` cannot span an `await`. So:
  - Transactions are exposed **only** as callback-style `tx(fn)`. No manual `begin()`/`commit()` in the public API.
  - The adapter decides how to execute the transaction.
  - Document clearly that DO transactions must not await external I/O inside `fn`.

### Testing guidance

- Do **not** use SQLite as a test stand-in for PostgreSQL apps. Semantics differ (types, coercion, constraints, collation, dates).
- For in-memory PG tests, use the **PGlite adapter**.

### SQLite specifics to handle

- Single writer: use `BEGIN IMMEDIATE` where appropriate
- `RETURNING` requires SQLite 3.35+
- `ON CONFLICT` upserts are supported by both dialects

## Suggested build order

1. Adapter contract + capabilities descriptor
2. `node:sqlite` adapter + `pg` / `postgres.js` adapter
3. **Durable Objects adapter early**: it is the most constrained target and will validate or break the contract fastest
4. SQL tagged-template composition
5. Error normalization
6. Migrations runner
7. PGlite adapter
8. Repository/table helper

## Conventions

- TypeScript, ESM, published under `@marianmeres` (JSR/npm), following existing package conventions
- Pragmatic domain modelling, no over-engineering
- Runtime: Node primary (ecosystem migrating from Deno), keep runtime-agnostic where cheap
- Adapters as separate entry points/subpath exports, so the core has no driver dependencies
