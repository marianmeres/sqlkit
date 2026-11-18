<!--
GENERATED ANALYSIS — @marianmeres/sqlkit v0 foundation
Produced 2026-11-18 by inline research → owner interview (two rounds) → verification.
Tooling claims verified against the config files snapshotted in tmp/prior-art/tooling/ and
the standing runtime policy (Node at the keyboard and in production, npm as the registry).
Planning artifact; no code was changed.
-->

# Scaffold, docs, release

> The repository holds a brief, this plan and a `.gitignore`, and has no commit. A sprint
> needs a default branch with a clean tree and a verification command that passes, so the
> first row is done by hand: the scaffold, the test database, the first commit.
>
> The package follows the newest single-package convention in the ecosystem (the tooling
> snapshot): Node LTS, pnpm, Biome, `node:test`, erasable TypeScript run as written,
> `dist/` built by `tsc` for npm only. It is published to npm as `restricted` during 0.x
> and written public-clean from the first file (D02). No JSR: the standing policy allows
> it only while a Deno consumer exists, and a new package has none (D21).
>
> The release is not a row. The owner cuts 0.1.0 when the sprint is done.

## Summary of recommendations

| # | Recommendation | Value | Effort | Risk |
|---|----------------|-------|--------|------|
| 1 | Pre-flight by hand: scaffold, test database, first commit | high | S | low |
| 2 | Agent docs, with a test that their links and named tests exist | med | M | low |
| 3 | Human docs, and a test that every export is documented | med | M | low |
| 4 | Archive this plan set | med | S | low |

## Findings & recommendations (detailed)

### 1. Pre-flight (owner, by hand)

- **Problem / observation** — Nothing can be verified yet: there is no `package.json`, so
  no command exits 0. A database credential is involved, and a row that writes under
  `.claude/` cannot be done unattended.
- **Evidence** — `git status` on 2026-11-18: no commits, `docs/` and `.gitignore`
  untracked. The config to mirror is in `tmp/prior-art/tooling/`.
- **Proposed change** — In one sitting:
  1. **Read the decisions log** in `PROGRESS.md`. D09–D24 are the plan author's calls:
     change any by editing its entry and the section it names, before any row runs.
  2. **Scaffold**, mirroring `tmp/prior-art/tooling/` with these differences:
     - `package.json`: name `@marianmeres/sqlkit`, version `0.0.0`,
       `publishConfig.access: "restricted"`, `engines.node: ">=24.12"`, `sideEffects:
       false`, `exports` with only `"."` (each adapter row adds its own subpath), no
       dependencies yet. Scripts: `build`, `clean`, `typecheck`, `lint`, `format`,
       `test` (`node --test --env-file-if-exists=.env "test/**/*.test.ts"`), `ci`
       (`typecheck`, then `lint`, then `test`), `release`, `rp`, `rpm` (release, then
       `pnpm publish`). No JSR script and no `jsr.json`.
     - `tsconfig.json`: as the snapshot, plus `"noUncheckedIndexedAccess": true`;
       `include` is `["src", "test"]`.
     - `biome.json`: as the snapshot, plus `!docs/plans` and `!docs/_archive/plans` in
       `files.includes`, so a tracker is never reflowed.
     - `.github/workflows/ci.yml`: as the snapshot, with the Postgres service's settings
       passed as `TEST_PG_HOST`, `TEST_PG_PORT`, `TEST_PG_DATABASE`, `TEST_PG_USER`,
       `TEST_PG_PASSWORD`.
     - `.env.example` documenting those five variables, and that the role needs `CREATE`
       on the database because every Postgres test case makes a schema of its own.
     - `.node-version`, `.editorconfig`, `LICENSE` (MIT), `src/mod.ts` (`export {};`),
       `test/unit/smoke.test.ts` (one passing test).
     - `test/unit/public-clean.test.ts`: every `@marianmeres/<name>` that appears in a
       tracked text file is on an allowlist of public package names held in the test
       (`sqlkit`, `migrate`, `semver`, `item-collection`, `release`, `steve`, `cron`,
       `kv`, `data-to-sql-params`, `condition-builder`). It is a tripwire for D02, not the
       whole rule.
     - `.claude/settings.json`: as `tmp/prior-art/tooling/claude-settings.json`.
  3. **Check `tmp/prior-art/`** is present and its `README.md` readable. It was created on
     2026-11-18 and is gitignored; a fresh clone does not have it.
  4. **Create the test database** in the local shared Postgres, with a role that has
     `CREATE` on it, and write `.env` from `.env.example`.
  5. `pnpm install`, then `pnpm run ci`: green.
  6. **Commit** everything on `master`.
  7. `sprint docs/plans/v0-foundation --dry-run`: it names T02 as the next task.
- **Done when** — `pnpm run ci` exits 0 on a clean tree at a commit on `master`; the
  dry run prints T02; the owner sets T01 to `✅`.
- **Affected files** — every file named above.
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes** — This row can be done in one interactive session by an agent
  working with the owner; it is `🔒` because of the credential, the `.claude/` write and
  the first commit, not because it is hard.

### 2. Agent docs

- **Problem / observation** — Rows T02–T16 land code with header comments and tests but
  no entry point for an agent arriving cold.
- **Proposed change** — Per the ecosystem's agent documentation guide, scaled to a single
  package:
  - `AGENTS.md`: quick reference (toolchain, the commands, the test database), project
    structure (the layout of doc 02), critical conventions, a before-changing checklist,
    the documentation index.
  - `CLAUDE.md`: a short package summary pointing at `AGENTS.md`.
  - `docs/architecture.md`: the three layers; the single-connection rule and where it
    lives; the two tiers and rules S1–S6; which adapter is which shape; the error boundary.
  - `docs/conventions.md`: SQL (fragments, never interpolation; identifiers through
    `ident`), parameters (the table of doc 01 #2), errors (`SqlError` for what a database
    did, `TypeError` for a programming mistake), testing (a behaviour goes in a
    conformance body and runs on every adapter; an adapter-specific test says why), the
    runtime policy, and the public-clean rule stated generically.
  - `docs/tasks.md`: add an adapter; add an error kind; add a conformance body.
  - `mcp-include.txt`: the package in three lines.
  - `test/unit/docs-links.test.ts`: every relative link in those files resolves, and every
    `test/...` path a doc names exists.
- **Done when** — the six files exist; `test/unit/docs-links.test.ts` passes;
  `test/unit/public-clean.test.ts` still passes with them in the tree.
- **Affected files** — the six files and the test.
- **Effort / Value / Risk** — M / med / low.
- **Implementation notes** — Describe what the code does today, by reading it. The rules
  R1–R10 and S1–S6 are quoted from the conformance bodies, not from this plan: the plan is
  archived by T20 and must not be the docs' source.

### 3. Human docs

- **Problem / observation** — A package without a README and an API reference is not
  releasable, even privately.
- **Proposed change** — Per the ecosystem's human documentation guide:
  - `README.md`: what sqlkit is and is not (the brief's goal and non-goals), install, a
    quick start per adapter, transactions, the sync tier, errors, builders, decoders,
    retry, migrations, the testing guidance (never SQLite as a stand-in for Postgres; use
    PGlite), and a "Before you rely on it" section: the single-connection wait-for-itself
    case, `withRetry`'s scope, the migrate wiring's two lock modes, the semver ordering
    limit. No registry badges while the package is restricted.
  - `API.md`: every export of every entry point, by entry point.
  - `test/unit/api-docs.test.ts`: every name exported from an entry point's `mod.ts`
    appears in `API.md` under that entry point.
  - `test/unit/exports.test.ts`: every target in `package.json`'s `exports` maps to a
    source file under `src/`, and every `src/**/mod.ts` or `src/migrate/files.ts` is
    exported.
  - `package.json`: `files` lists `dist`, `README.md`, `API.md`, `AGENTS.md`, `CLAUDE.md`,
    `LICENSE`. The version stays `0.0.0`: the owner's `pnpm run rpm` makes it `0.1.0`.
- **Done when** — both tests pass; `pnpm run build` exits 0; `README.md` has a section for
  each item listed above.
- **Affected files** — `README.md`, `API.md`, `package.json`,
  `test/unit/api-docs.test.ts`, `test/unit/exports.test.ts`.
- **Effort / Value / Risk** — M / med / low.
- **Implementation notes** — T19 lands after this row and adds `./do` to both files
  itself; write the adapter sections so that a fifth one slots in.

### 4. Archive this plan set

- **Problem / observation** — A finished plan left in `docs/plans/` reads as live work.
- **Proposed change** — `git mv docs/plans/v0-foundation docs/_archive/plans/v0-foundation`;
  repair the relative links the move breaks, inside the set and from `AGENTS.md`; copy the
  tracker's Backlog table to `docs/backlog.md` (which is where it stays open) and list it
  in `AGENTS.md`'s documentation index; point `docs/architecture.md`'s Durable Objects
  section at the archived `DO-FINDINGS.md`.
- **Done when** — `docs/plans/` holds no `v0-foundation`; `docs/backlog.md` exists;
  `test/unit/docs-links.test.ts` passes.
- **Affected files** — the moved directory, `AGENTS.md`, `docs/architecture.md`,
  `docs/backlog.md`.
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — This is the last row. The driver follows the tracker across
  the move and then stops.

## After the sprint (owner, not rows)

- **Release 0.1.0**: `pnpm run rpm`. `publishConfig.access` is `restricted`; never publish
  without it, because a scoped package published without it goes out public and that
  cannot be undone.
- **Going public** is backlog T21, and the precondition for steve, cron and kv to adopt
  sqlkit.

## Open questions / decisions needed

None.
