# @marianmeres/sqlkit — Agent Guide

A thin, convention-driven SQL toolkit for PostgreSQL and SQLite: `sql` fragments that keep
text and values apart, one driver contract (async, plus a sync tier where the engine is
synchronous), typed errors, transactions, statement builders, row decoders, retry, health
checks and migrations. Not an ORM, not a query builder. An app commits to one dialect.

## Quick Reference

- **Toolchain**: erasable TypeScript run as written by Node (LTS, `.node-version`; `>=24.12`),
  pnpm, Biome, `node:test`. Published to npm only, `access: restricted` during 0.x.
- **Gate**: `pnpm run ci` (typecheck, lint, test) | **Test**: `pnpm test` |
  **Build**: `pnpm run build` (`dist/`, for npm only) | **Format**: `pnpm run format`
- **One adapter**: `pnpm run test:sqlite`, `test:pg` (pool and client), `test:pglite`
- **Test database**: a real Postgres from `TEST_PG_*` in `.env` (see `.env.example`).
  Missing, the suite fails; nothing skips. The role needs `CREATE` on the database: every
  Postgres case makes a schema of its own.
- **Durable Objects tests** (`test/do/`) start workerd through Miniflare; `pnpm install`
  must run the esbuild and workerd install scripts (allowed in `pnpm-workspace.yaml`).

## Project Structure

| Path                                       | Export            | Holds                                                                               |
| ------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------- |
| `src/mod.ts`                               | `.`               | the core, runtime-neutral (re-exports `src/core/`)                                  |
| `src/core/`                                |                   | fragments, contract, params, errors, classifiers, builders, decoders, retry, health |
| `src/single/`                              |                   | the single-connection driver core and its backend seam                              |
| `src/sqlite/mod.ts`                        | `./sqlite`        | node:sqlite (with the sync tier)                                                    |
| `src/pg/mod.ts`                            | `./pg`            | node-postgres: a pool, or one client                                                |
| `src/pglite/mod.ts`                        | `./pglite`        | PGlite                                                                              |
| `src/migrate/mod.ts`                       | `./migrate`       | `@marianmeres/migrate` wired over a `Driver`                                        |
| `src/migrate/files.ts`                     | `./migrate/files` | SQL files as versions (Node only)                                                   |
| `test/conformance/`                        |                   | bodies every adapter runs, their binders, the registry                              |
| `test/unit/`                               |                   | no database: pure functions, stub backends, guards                                  |
| `test/pg/`, `test/pglite/`, `test/sqlite/` |                   | one adapter's own suites and fixture                                                |
| `test/do/`                                 |                   | workerd harness and the Durable Objects probe                                       |

## Critical Conventions

1. SQL is built from `sql` fragments: a value is bound, never written into the text; an
   identifier goes through `ident`. `raw` only for text the code owns.
2. `src/core/` and `src/mod.ts` import only `src/core/`; `src/single/` adds
   `node:async_hooks`. Checked by `test/unit/core-imports.test.ts`.
3. A behaviour of the contract is a case in a conformance body under `test/conformance/`,
   which imports no `node:test` and runs on every adapter. An adapter-specific test lives
   in `test/<adapter>/` and says why.
4. A database failure is a `SqlError` subclass, wrapped at the adapter boundary with the
   driver's error as `cause`. A programming mistake is a `TypeError`. A callback's own
   error passes through untouched.
5. No adapter imports its driver library: the host builds the client, the adapter
   declares its shape structurally. No peer dependency.
6. Erasable TypeScript only, `.ts` import extensions, `import type` for types. No
   `Deno.*` or `Bun.*`.
7. Public-clean: no committed file names a private package
   (`test/unit/public-clean.test.ts` is the tripwire).
8. Postgres is never skipped. A server a test starts takes an OS-assigned port.

## Before Making Changes

- [ ] Read the section of `docs/architecture.md` for the layer you touch.
- [ ] Find the rule in the conformance body: R1–R11 in `test/conformance/driver.ts`,
      S1–S6 in `test/conformance/sync.ts`; the contract states them in
      `src/core/contract.ts`.
- [ ] Follow `docs/conventions.md`; for a recurring change, `docs/tasks.md`.
- [ ] `pnpm run format`, then `pnpm run ci` green (needs the test Postgres).
- [ ] Update the docs the change invalidates: this file, `docs/`, `README.md`, `API.md`.
      A new export goes in `API.md` under its entry point
      (`test/unit/api-docs.test.ts`); a new entry point in `package.json`'s `exports`
      (`test/unit/exports.test.ts`).

Source comments cite decisions as `Dnn` and plan sections as "plan doc NN #n": both are in
the plan set under `docs/plans/v0-foundation/`.

## Documentation Index

- [README](./README.md): what sqlkit is and is not, a quick start per adapter, the
  caveats
- [API](./API.md): every export of every entry point
- [Architecture](./docs/architecture.md): layers, the single-connection rule, tiers,
  adapters, the error boundary, migrations
- [Conventions](./docs/conventions.md): SQL, parameters, errors, testing, runtime,
  public-clean
- [Tasks](./docs/tasks.md): add an adapter, an error kind, a conformance body
- [Brief](./docs/sqlkit-brief.md): the original goal and non-goals
- [Plan tracker](./docs/plans/v0-foundation/PROGRESS.md): the v0 sprint and its
  decisions log
