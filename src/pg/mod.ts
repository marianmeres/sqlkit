/**
 * The Postgres adapter (`./pg`), over node-postgres.
 *
 * `createPgDriver(pool, options)` is a `Driver` over a `pg.Pool` the host built: a
 * transaction pins one connection for its length, `exclusive` is an advisory lock every
 * process on the same database and schema honours, and `options.schema` binds every
 * connection the driver checks out to one schema.
 *
 * Nothing is imported from `pg`: the shapes the adapter takes are declared structurally
 * (`PgPoolLike`), so the package has no peer dependency.
 */

export { createPgDriver } from "./pool.ts";
export type {
	PgClientLike,
	PgDriverOptions,
	PgPoolClientLike,
	PgPoolLike,
	PgQueryResultLike,
} from "./types.ts";
