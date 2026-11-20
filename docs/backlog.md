# Backlog

Work after v0, ranked, not scheduled. This is the open copy: change it here.

The table was copied from the v0 plan's tracker when that plan was archived, and its ids
continue the plan's. The tracker, its decisions log (`Dnn`) and the plan docs are in
[`_archive/plans/v0-foundation/`](./_archive/plans/v0-foundation/PROGRESS.md); a row's
Source names the plan doc, and the section (`#n`) where there is one, that it came from.

**Status:** ⬜ open · 🔒 owner only · 🚧 in progress · ✅ done

| Status | ID  | Rank | Task                                                                                                                                                                                 | Source                                                           |
| ------ | --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| ✅     | T21 | 1    | Owner: make the package public on npm. Precondition for T22–T24. Irreversible.                                                                                                       | [04](./_archive/plans/v0-foundation/04-scaffold-docs-release.md) |
| ✅     | T22 | 2    | Adopt in steve: its transaction, retry, health and quoting helpers and its insert helper go; needs its own plan                                                                      | [00](./_archive/plans/v0-foundation/00-overview-and-roadmap.md)  |
| ⬜     | T23 | 3    | Adopt in cron: same helpers; needs its own plan                                                                                                                                      | [00](./_archive/plans/v0-foundation/00-overview-and-roadmap.md)  |
| ⬜     | T24 | 4    | Adopt in kv: its Postgres and SQLite adapters; needs its own plan                                                                                                                    | [00](./_archive/plans/v0-foundation/00-overview-and-roadmap.md)  |
| ✅     | T25 | 5    | Adopt in the prior implementation: an opt-in driver over sqlkit beside its own, which stay the default. Replacing them is deferred there. Its step ledger stays, without `./migrate` | [00](./_archive/plans/v0-foundation/00-overview-and-roadmap.md)  |
| ✅     | T26 | 6    | Savepoints (`tx.savepoint(fn)`), so a migrate run on a single-connection adapter keeps the steps before a failed one                                                                 | [03](./_archive/plans/v0-foundation/03-conventions.md) #2        |
| ⬜     | T27 | 7    | `better-sqlite3` adapter: a second `SyncBackend`. No consumer yet.                                                                                                                   | [02](./_archive/plans/v0-foundation/02-adapters.md)              |
| ⬜     | T28 | 8    | `postgres.js` adapter. No consumer yet.                                                                                                                                              | [02](./_archive/plans/v0-foundation/02-adapters.md)              |
| ✅     | T29 | 9    | Prepared-statement cache in the node:sqlite backend                                                                                                                                  | [00](./_archive/plans/v0-foundation/00-overview-and-roadmap.md)  |
| ⬜     | T30 | 10   | Export the conformance bodies as `./testing`, for adapters written outside this package                                                                                              | [02](./_archive/plans/v0-foundation/02-adapters.md) #2           |
| ⬜     | T31 | 11   | An isolation-level option on `transaction`                                                                                                                                           | [00](./_archive/plans/v0-foundation/00-overview-and-roadmap.md)  |
| ⬜     | T32 | 12   | Dialect-specific SQL file variants (`.pg.sql`, `.sqlite.sql`) for libraries that support both                                                                                        | [03](./_archive/plans/v0-foundation/03-conventions.md) #4        |
| ✅     | T34 | 13   | `SqlError` recognized across copies: two 0.x minors in one app are two classes, so `instanceof` and `withRetry`'s default miss the other's errors. Brand it, as `sql` is             | kv, on adopting 0.2.0                                            |
