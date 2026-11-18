/**
 * The shapes the Postgres adapter takes, declared structurally: a node-postgres `pg.Pool`
 * or `pg.Client` fits them as it is, and so does anything shaped like one. The adapter
 * imports nothing from `pg`, not even its types, so the package has no peer dependency and
 * the host decides which `pg` it runs and how its pool or client is configured.
 *
 * Only what the adapter calls is declared.
 */

/** How `createPgDriver` and `createPgClientDriver` bind their driver to the database. */
export interface PgDriverOptions {
	/**
	 * One schema, applied as the whole `search_path` of every connection the driver
	 * uses, once per connection, before its first statement there: a table is created
	 * in, and found in, exactly one place. Left unset, the connection's own `search_path`
	 * stands.
	 *
	 * It is set on the connection, not per statement, so whoever uses that connection
	 * afterwards sees it too: another user of the same pool, or the host on its client.
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

/** One statement as node-postgres takes it: its text, its values, how it is sent. */
export interface PgQueryConfigLike {
	text: string;
	values?: unknown[];
	/**
	 * `"extended"` sends the text as one parameterized statement even with no values, so
	 * the server refuses a text of several before running any of it. Left unset with no
	 * values, node-postgres sends a simple query, which runs every statement it holds. A
	 * node-postgres that predates the option ignores it.
	 */
	queryMode?: "extended";
}

/** One session a statement runs on: a `pg.PoolClient` a pool handed out, or a `pg.Client`. */
export interface PgClientLike {
	query(config: PgQueryConfigLike): Promise<PgQueryResultLike>;
}

/**
 * One client of its own, not a pool's: a node-postgres `pg.Client` the host connected, or
 * anything shaped like one. What `createPgClientDriver` takes.
 */
export interface PgStandaloneClientLike extends PgClientLike {
	/** Disconnect. What the driver's `close()` calls. */
	end(): Promise<void>;
	/**
	 * The client's `error` event: its connection failed while nothing was running on it.
	 * A client nobody listens to ends the process on the first one, so the adapter
	 * listens.
	 */
	on(event: "error", listener: (error: Error) => void): unknown;
	/** How many `error` listeners there are: the adapter stays quiet when the host listens. */
	listenerCount(event: "error"): number;
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
