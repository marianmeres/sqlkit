// The few Cloudflare types the test workers use, declared structurally from the workers
// runtime's published type definitions. The full definitions are not installed: their
// globals collide with Node's. Only `DurableObject` exists at runtime; everything else
// here is a type, imported with `import type` and erased.
declare module "cloudflare:workers" {
	/** A value a SQLite-backed Durable Object stores and returns. */
	export type SqlStorageValue = ArrayBuffer | string | number | null;

	/** What `sql.exec` returns: the statement has run, its rows are read on demand. */
	export interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> {
		next(): { done?: false; value: T } | { done: true; value?: never };
		toArray(): T[];
		one(): T;
		raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
		readonly columnNames: string[];
		readonly rowsRead: number;
		readonly rowsWritten: number;
		[Symbol.iterator](): IterableIterator<T>;
	}

	export interface SqlStorage {
		exec<T extends Record<string, SqlStorageValue>>(
			query: string,
			...bindings: unknown[]
		): SqlStorageCursor<T>;
		readonly databaseSize: number;
	}

	export interface DurableObjectStorage {
		readonly sql: SqlStorage;
		transactionSync<T>(closure: () => T): T;
		transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T>;
	}

	export interface DurableObjectState {
		readonly storage: DurableObjectStorage;
		blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
	}

	export abstract class DurableObject<Env = unknown> {
		protected ctx: DurableObjectState;
		protected env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}
}
