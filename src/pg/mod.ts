/**
 * The Postgres adapter (`./pg`), over node-postgres. Two factories, so that nothing is
 * guessed from an object's shape:
 *
 * - `createPgDriver(pool, options)` is a `Driver` over a `pg.Pool` the host built: a
 *   transaction pins one connection for its length, `exclusive` is an advisory lock every
 *   process on the same database and schema honours, and `options.schema` binds every
 *   connection the driver checks out to one schema.
 * - `createPgClientDriver(client, options)` is a `Driver` over one `pg.Client` the host
 *   connected, the same in every respect but one: a statement from outside an open
 *   transaction waits for it to end, where a pool would run it on another connection.
 *
 * A library that takes whichever its host has, a pool, a client or a `Driver`, cannot say
 * which it was handed, so `toPgDriver(db)` reads the shape for it, by one stated rule,
 * and keeps one driver per pool and per client (`to-driver.ts`).
 *
 * Nothing is imported from `pg`: the shapes the adapter takes are declared structurally
 * (`PgPoolLike`, `PgStandaloneClientLike`), so the package has no peer dependency.
 */

export { createPgClientDriver } from "./client.ts";
export { createPgDriver } from "./pool.ts";
export { type PgDb, toPgDriver } from "./to-driver.ts";
export type {
	PgClientLike,
	PgDriverOptions,
	PgPoolClientLike,
	PgPoolLike,
	PgQueryConfigLike,
	PgQueryResultLike,
	PgStandaloneClientLike,
} from "./types.ts";
