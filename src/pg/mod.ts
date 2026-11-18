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
 * Nothing is imported from `pg`: the shapes the adapter takes are declared structurally
 * (`PgPoolLike`, `PgStandaloneClientLike`), so the package has no peer dependency.
 */

export { createPgClientDriver } from "./client.ts";
export { createPgDriver } from "./pool.ts";
export type {
	PgClientLike,
	PgDriverOptions,
	PgPoolClientLike,
	PgPoolLike,
	PgQueryConfigLike,
	PgQueryResultLike,
	PgStandaloneClientLike,
} from "./types.ts";
