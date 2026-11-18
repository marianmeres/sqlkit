/**
 * The shapes the Postgres adapter takes, declared structurally: a node-postgres `pg.Pool`
 * fits them as it is, and so does anything shaped like one. The adapter imports nothing
 * from `pg`, not even its types, so the package has no peer dependency and the host
 * decides which `pg` it runs and how its pool is configured.
 *
 * Only what the adapter calls is declared.
 */

/** How `createPgDriver` binds its driver to the database. */
export interface PgDriverOptions {
	/**
	 * One schema, applied as the whole `search_path` of every connection the driver
	 * checks out, once per connection: a table is created in, and found in, exactly one
	 * place. Left unset, the pool's own `search_path` stands.
	 *
	 * It is set on the connection, not per statement, so another user of the same pool
	 * that is handed that connection later sees it too.
	 */
	schema?: string;
}

/** The part of a node-postgres query result the adapter reads. */
export interface PgQueryResultLike {
	/** One object per row. */
	rows: Record<string, unknown>[];
	/** Rows returned or affected; `null` for a command that counts nothing (DDL). */
	rowCount: number | null;
	/** The command tag: `"SELECT"`, `"COMMIT"`, `"ROLLBACK"`, … */
	command: string;
}

/**
 * One session a statement runs on: a `pg.PoolClient` a pool handed out, or a `pg.Client`.
 * Given no `values`, node-postgres sends the text as one simple query, which may hold
 * several statements; given values, as one parameterized statement.
 */
export interface PgClientLike {
	query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
}

/** A connection a pool handed out: a `pg.PoolClient`, or anything shaped like one. */
export interface PgPoolClientLike extends PgClientLike {
	/**
	 * Hand the connection back to the pool. A truthy argument destroys it instead: what
	 * the adapter does with a connection whose state it cannot vouch for.
	 */
	release(destroy?: Error | boolean): void;
}

/** A connection pool: a `pg.Pool`, or anything shaped like one. */
export interface PgPoolLike {
	/** Check one connection out, until it is released. */
	connect(): Promise<PgPoolClientLike>;
	/** Disconnect every connection and refuse new checkouts. */
	end(): Promise<void>;
	/**
	 * The pool's `error` event: an idle connection the server dropped. A pool nobody
	 * listens to ends the process on the first one, so the adapter listens.
	 */
	on(event: "error", listener: (error: Error) => void): unknown;
	/** How many `error` listeners there are: the adapter stays quiet when the host listens. */
	listenerCount(event: "error"): number;
}
