# Tasks

## Add an Adapter

A database reached through one connection (an embedded engine, one client) is a backend
of the single-connection driver core. A pool of many connections is not: follow
`src/pg/pool.ts` instead (a connection pinned per transaction through
`AsyncLocalStorage`, every driver call guarded).

### Steps

1. Create `src/<name>/mod.ts` with a header doc comment: what it wraps, its transaction
   statements, its lock (or none), what `close()` ends.
2. Declare the client's shape structurally (`<Name>Like`): only the members the adapter
   calls. Import nothing from the driver library, not even its types.
3. Implement `SingleConnectionBackend` (`src/single/backend.ts`): `run`, `exec`,
   `transaction(fn, readOnly)`, `savepoint(fn, inner, name)`, `classify` (the dialect's
   classifier), `close`, and `lock(name, inTransaction)` only where the database has a
   lock other processes honour. Throw the driver's errors as they are: the core wraps
   them. Throw a `TypeError` for a refusal of the backend's own. A database that takes
   `SAVEPOINT` gets its `savepoint` from `savepointBy` (`src/core/savepoint.ts`); one that
   does not nests its library's own transaction.
4. Where the engine is synchronous, implement `SyncBackend` too (its `savepoint` from
   `savepointBySync`); the core builds `driver.sync` over it.
5. Export `create<Name>Driver(client)`, which refuses a value of the wrong shape with a
   `TypeError` and returns `createSingleConnectionDriver(backend, sync?)`.
6. `package.json`: add `"./<name>"` to `exports` (`types` and `default` under `dist/`); add
   the client library to `devDependencies` only; add a `test:<name>` script on the pattern
   of `test:pglite` (`--test-name-pattern="^<name>\\b"`, reading `test/conformance/` and
   `test/<name>/`).
7. Create `test/<name>/_fixture.ts`: a fresh, isolated database per call, as a `Fixture`
   (`test/conformance/_suite.ts`). It imports no `node:test`.
8. Register it in `test/conformance/_adapters.ts`: `{ name, sync, create }`. `sync` is
   stated, not read from the driver. Check that the name is not matched by another
   adapter's `test:*` pattern (`^pg\b` matches `pg-client`, not `pglite`).
9. Put what only this adapter does in `test/<name>/<topic>.test.ts`, under
   `describe("<name>/<topic>")`, with a header saying why it is not a conformance case.
10. Update the adapter table in `docs/architecture.md` and the structure table in
    `AGENTS.md`. Add the entry point's section to `API.md`, every export under it
    (`test/unit/api-docs.test.ts`), and its quick start and table row to `README.md`.

### Template

```ts
/**
 * The Example adapter (`./example`): a `Driver` over an Example client the host created,
 * or anything shaped like one (`ExampleLike`). One connection: a backend of the
 * single-connection driver core. …
 */

import { classifySqlite } from "../core/classify-sqlite.ts";
import type { Driver, QueryResult, Row } from "../core/contract.ts";
import { savepointBy } from "../core/savepoint.ts";
import type { Connection, SingleConnectionBackend } from "../single/backend.ts";
import { createSingleConnectionDriver } from "../single/driver.ts";

/** The part of an Example client the adapter uses. */
export interface ExampleLike {
	/** One statement: its rows, how many columns it returns, how many rows it wrote. */
	run(text: string, params: readonly unknown[]): {
		rows: Row[];
		columns: number;
		changes: number;
	};
	exec(script: string): void;
	close(): void;
}

export function createExampleDriver(client: ExampleLike): Driver {
	if (typeof client?.run !== "function") {
		throw new TypeError("createExampleDriver(client) takes an Example client");
	}
	const run = (text: string, params: readonly unknown[]): QueryResult<Row> => {
		const { rows, columns, changes } = client.run(text, params);
		return { rows, rowCount: columns > 0 ? rows.length : changes };
	};
	const exec = (script: string): void => client.exec(script);
	const backend: SingleConnectionBackend = {
		dialect: "sqlite",
		adapter: "example",
		run,
		exec,
		async transaction<T>(fn: (inner: Connection) => Promise<T>, readOnly: boolean) {
			exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
			try {
				const result = await fn(backend);
				exec("COMMIT");
				return result;
			} catch (error) {
				try {
					exec("ROLLBACK");
				} catch {
					// A failed ROLLBACK is a symptom; the error that led here is the cause.
				}
				throw error;
			}
		},
		savepoint<T>(fn: () => Promise<T>, _inner: Connection, name: string) {
			return savepointBy(exec, name, fn);
		},
		classify: classifySqlite,
		close: () => client.close(),
	};
	return createSingleConnectionDriver(backend);
}
```

### Checklist

- [ ] Every conformance body passes on it: `pnpm run test:<name>`, then `pnpm run ci`.
- [ ] `query` refuses a text of several statements before any of it runs (R11).
- [ ] A read-only transaction refuses a write with a `ReadOnlyError` (R7).
- [ ] A savepoint is undone alone, and the transaction goes on (R12).
- [ ] Rows are plain objects; bytes read back as a `Uint8Array` (R10).
- [ ] `capabilities` is what the core derives: `sync` from a `SyncBackend`,
      `crossProcessLock` from `lock`.
- [ ] Nothing under `src/<name>/` imports the driver library.

## Add an Error Kind

### Steps

1. `src/core/errors.ts`: add the kind to `SqlErrorKind` and to `KINDS`; add a subclass
   `<Kind>Error extends SqlError` with a one-line doc comment; add it to `CLASS_OF` and to
   the loop that sets each class's `name`. Add the kind to `RETRYABLE` only if running the
   same work again may succeed.
2. `src/mod.ts`: export the class.
3. Teach the classifiers what reads as it: `KIND_OF_CODE` (SQLSTATE) in
   `src/core/classify-pg.ts`; `KIND_OF_ERRCODE` (extended code) or `KIND_OF_PRIMARY`
   (primary code) in `src/core/classify-sqlite.ts`. A dialect that cannot report it maps
   nothing to it.
4. `test/unit/errors.test.ts`: add a row to `KINDS` and raise the count in "every kind of
   SqlErrorKind has a row here".
5. `test/unit/classify.test.ts`: the fabricated driver errors that read as the kind, and
   the fields read from them.
6. Provoke the real failure: a case in `test/conformance/errors.ts` when every adapter can
   raise it, asserting each dialect's fields; otherwise in `test/<adapter>/errors.test.ts`,
   saying why (two connections, a server setting).
7. Update the error boundary section of `docs/architecture.md` when the kind is retryable,
   and add the class to the error table in `API.md` (`test/unit/api-docs.test.ts`) and
   to the list in `README.md`.

### Checklist

- [ ] `toSqlError` builds the new class for the kind (not a bare `SqlError`).
- [ ] `retryable` is right for it.
- [ ] A field the database does not report is asserted absent, not guessed.

## Add a Conformance Body

### Steps

1. Create `test/conformance/<body>.ts` exporting `<body>Contract(suite, adapter)`. Import
   `node:assert/strict` and `src/mod.ts`; never `node:test`.
2. Register every case with `suite.test(name, fn)`, the name starting with the body's
   prefix or rule (`<body>: …`).
3. Each case creates a database with `adapter.create()` and disposes it in `finally`.
4. Write portable SQL or `sql` fragments. Where the behaviour differs by dialect, branch
   on `db.dialect` and assert each side. Where the adapter has a sync tier
   (`adapter.sync`), run the sync side too.
5. Create the binder `test/conformance/<body>.test.ts` on the pattern below.
6. Run `pnpm test`: the case names appear under every adapter's `describe`.

### Template

```ts
// Binds the `<body>` conformance body to `node:test`, once per registered adapter, under
// `describe(adapter.name)`. Only `*.test.ts` files in this directory import `node:test`.
import { describe, test } from "node:test";
import { ADAPTERS } from "./_adapters.ts";
import { exampleContract } from "./example.ts";

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		exampleContract({ test: (name, fn) => void test(name, () => fn()) }, adapter);
	});
}
```

```ts
import assert from "node:assert/strict";
import { type Driver, sql } from "../../src/mod.ts";
import type { AdapterCase, Suite } from "./_suite.ts";

export function exampleContract(suite: Suite, adapter: AdapterCase): void {
	const test = (name: string, body: (db: Driver) => Promise<void>): void => {
		suite.test(name, async () => {
			const fixture = await adapter.create();
			try {
				await body(fixture.driver);
			} finally {
				await fixture.dispose();
			}
		});
	};

	test("example: a bound value reads back", async (db) => {
		const { rows } = await db.query(sql`select ${"x"} as v`);
		assert.deepEqual(rows, [{ v: "x" }]);
	});
}
```

### Checklist

- [ ] `test/unit/conformance-imports.test.ts` passes: no `node:test` reached from the body.
- [ ] Every registered adapter runs it, none skipped.
- [ ] The body says in its header comment what it holds the adapters to.
