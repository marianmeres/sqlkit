# v0 Foundation — @marianmeres/sqlkit

The plan that builds sqlkit from an empty repository to a documented, releasable 0.1.0: the
`sql` fragment builder, the driver contract with its sync tier, five adapters, typed
errors, and the conventions layer. Produced on 2026-11-18 from the project brief
([`docs/sqlkit-brief.md`](../../../sqlkit-brief.md)), a review of the existing SQL code in the
ecosystem, and a two-round interview with the owner. It is a planning artifact: no code was
changed, and its technical claims were checked against the prior-art snapshot in
`tmp/prior-art/` (gitignored; its README lists sources and commits).

**Start here:** [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md). To work a
task, start at [`PROGRESS.md`](./PROGRESS.md).

## Documents

| # | Doc | Scope | Headline finding |
|---|-----|-------|------------------|
| 00 | [overview-and-roadmap](./00-overview-and-roadmap.md) | synthesis, the sprint, where the plan departs from the brief | sqlkit is an extraction: most of the contract and the fragment builder exist and are tested |
| 01 | [core](./01-core.md) | `sql` fragments, the contract, the parameter rule, `SqlError` | one contract, two tiers; errors typed at the adapter boundary |
| 02 | [adapters](./02-adapters.md) | the single-connection core, node:sqlite, Postgres pool and client, PGlite, Durable Objects | four of five adapters are one connection, so their hard part is written once |
| 03 | [conventions](./03-conventions.md) | statement builders, row decoders, retry and health, migrations | everything but migrations is a pure function; migrations are wiring for `@marianmeres/migrate` |
| 04 | [scaffold-docs-release](./04-scaffold-docs-release.md) | the pre-flight, agent and human docs, archiving, the release | the first row is by hand; the release is not a row |
| — | [PROGRESS](./PROGRESS.md) | the tracker: twenty rows, the backlog, decisions D01–D24 | two runs, with one owner checkpoint between them |

`DO-FINDINGS.md` joins this directory when T04 runs.

## How it was produced

Inline research of three packages and the prior implementation, an interview that settled
eight decisions (D01–D08), a design pass that made sixteen more (D09–D24, each open to
veto), and a verification pass that re-opened every cited file.

> D09–D24 are not the owner's yet. `PROGRESS.md` lists them, and T12 is the scheduled
> point to confirm or change the ones the second half of the sprint depends on.
