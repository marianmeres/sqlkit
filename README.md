# @marianmeres/sqlkit

A thin SQL toolkit for PostgreSQL and SQLite: `sql` fragments that keep text and values
apart, one driver contract over node:sqlite, node-postgres, PGlite and the SQLite storage
of Cloudflare Durable Objects, typed errors, transactions, statement builders, row
decoders, retry, health checks and migrations.

## What it is, and what it is not

sqlkit gives every database the same tooling and the same API shape. An app still
commits to **one dialect**, Postgres (`pg`) or SQLite (`sqlite`), and writes that
dialect's SQL freely: `jsonb`, arrays, `timestamptz`, `ILIKE`. It is not "write once, run
on both", and it does not aim at a lowest common denominator.

What it is:

- **SQL fragments.** A tagged template binds every value and composes: a fragment inside
  a fragment is spliced, and placeholders (`$1` or `?`) are written last.
- **One driver contract.** `query`, `exec`, `transaction`, `savepoint`, `exclusive`,
  `close`, the same on every adapter, plus a synchronous tier where the engine is
  synchronous.
- **Typed errors.** A unique violation is a `UniqueViolationError` on every database, with
  the driver's error kept as `cause`.
- **Conventions on top:** statement builders, explicit row decoders, retry, health checks
  and migrations.

What it is not:

- **Not an ORM.** No models, no schema declaration, no relations.
- **Not a query builder.** There is no `select` builder: a query is what the `sql` tag is
  for. SQL stays SQL; sqlkit makes it safe, composable and the same to run everywhere.

## Installation

```sh
npm install @marianmeres/sqlkit
```

Node 24.20 or later on the 24 line, or 26.6 or later; not 25. An earlier `node:sqlite`
misreads a statement's columns after a schema change. Then the client of your database,
which you build and hand to the adapter: sqlkit imports no driver and has no peer
dependency.

| Database                 | Client to install                                    |
| ------------------------ | ---------------------------------------------------- |
| SQLite                   | nothing: `node:sqlite` is built in                   |
| Postgres                 | `npm install pg`                                     |
| PGlite (in memory)       | `npm install @electric-sql/pglite`                   |
| Durable Objects (SQLite) | nothing: the object's `ctx.storage`, `nodejs_compat` |

## Quick start

Each adapter is its own entry point and turns a client into a `Driver`. Everything after
that is the same on all of them.

| Entry point                  | Factory                                                        | Dialect  | `db.sync` | Shape          |
| ---------------------------- | -------------------------------------------------------------- | -------- | --------- | -------------- |
| `@marianmeres/sqlkit/sqlite` | `openSqlite(path, options)`, `createSqliteDriver(db, options)` | `sqlite` | yes       | one connection |
| `@marianmeres/sqlkit/pg`     | `createPgDriver(pool, options)`                                | `pg`     | no        | a pool         |
| `@marianmeres/sqlkit/pg`     | `createPgClientDriver(client, options)`                        | `pg`     | no        | one connection |
| `@marianmeres/sqlkit/pglite` | `createPgliteDriver(db)`                                       | `pg`     | no        | one connection |
| `@marianmeres/sqlkit/do`     | `createDoDriver(ctx.storage)`                                  | `sqlite` | yes       | one connection |

`close()` ends the client the adapter was given. A host that keeps its client does not
call it. On Durable Objects it ends the driver and leaves the object's storage as it is.

### SQLite (node:sqlite)

```ts
import { openSqlite } from "@marianmeres/sqlkit/sqlite";

// A busy timeout (5000 ms) and, for a file, the WAL journal. ":memory:" by default.
const db = openSqlite("app.db");
```

A query or a data change is compiled once and kept for the next call with the same text
(`statementCache`, 128 statements by default).

`createSqliteDriver(new DatabaseSync(path))` takes a database you opened and sets nothing
on it. It keeps no statement unless you ask: see
[`SqliteDriverOptions`](./API.md#sqlitedriveroptions).

### Postgres, a pool (node-postgres)

```ts
import pg from "pg";
import { createPgDriver } from "@marianmeres/sqlkit/pg";

const pool = new pg.Pool({
	connectionString: process.env.DATABASE_URL,
	connectionTimeoutMillis: 5_000,
});
const db = createPgDriver(pool, { schema: "app" }); // `schema` is optional
```

A transaction pins one pooled connection for its length; a statement from outside it
runs on another connection at once.

### Postgres, one client

```ts
import pg from "pg";
import { createPgClientDriver } from "@marianmeres/sqlkit/pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const db = createPgClientDriver(client);
```

The same driver over one session: a statement from outside an open transaction waits for
it to end.

### PGlite

```ts
import { PGlite } from "@electric-sql/pglite";
import { createPgliteDriver } from "@marianmeres/sqlkit/pglite";

const db = createPgliteDriver(await PGlite.create());
```

Postgres compiled to WebAssembly, in this process: the in-memory database for testing
code that runs on Postgres.

### Durable Objects

```ts
import { DurableObject } from "cloudflare:workers";
import { createDoDriver } from "@marianmeres/sqlkit/do";

export class Room extends DurableObject {
	db = createDoDriver(this.ctx.storage);
}
```

The storage of a SQLite-backed Durable Object. The Worker needs the `nodejs_compat`
compatibility flag: the driver carries a transaction in `AsyncLocalStorage`. `db.sync` is
the same storage, synchronously, and its `transaction` is `storage.transactionSync`. A
savepoint is the storage's own transaction, nested in the open one.
Where workerd differs from node:sqlite:

- **An async transaction holds the whole object.** While it is open, no other request
  reaches the object, even while it awaits a timer or a `fetch`. Do not await external
  I/O inside one: do the I/O first, then open the transaction.
- **`query` cannot refuse a text of several statements**: workerd runs every statement of
  a text given no values. Pass one statement to `query`, a script to `exec`.
- **A script cannot hold its own transaction**: workerd refuses `BEGIN`, `SAVEPOINT`,
  `COMMIT` and `ROLLBACK`, a migration file's included. `transaction` and `savepoint` are
  the way.
- **A read-only transaction detects a write after it ran** (workerd does not authorize
  `PRAGMA query_only`) and rolls the transaction back, rejecting with a `ReadOnlyError`
  even when the callback caught the first one. DDL that is not the last statement of a
  text goes unseen.
- **A deferred constraint is not checked by `transaction`.** workerd checks a
  `deferrable initially deferred` foreign key when the request ends, and a violation then
  resets the object to its last good state and fails the request. Keep foreign keys
  immediate.
- **A `bigint` binds as a number**, since workerd binds no `bigint`; one outside the
  safe-integer range is a `TypeError`. An integer column reads back as a number.

## Queries

```ts
import { ident, json, sql } from "@marianmeres/sqlkit";

// SQLite's DDL; on Postgres, `id integer generated always as identity primary key`
await db.exec(`
	create table if not exists job (id integer primary key, tenant text, data text);
	create index if not exists job_tenant on job (tenant);
`);

const tenant = "acme";
await db.query(sql`insert into job (tenant, data) values (${tenant}, ${json({ a: 1 })})`);

const where = sql`tenant = ${tenant}`;
const { rows, rowCount } = await db.query(
	sql`select * from ${ident("job")} where ${where} order by id limit ${10}`,
);
```

- Every interpolated value is bound, never written into the text. An interpolated
  fragment is spliced, with its own values.
- `ident("app", "job")` quotes an identifier, `raw("now()")` is literal SQL your code owns,
  `json(value)` binds JSON text, `join(parts, ", ")` and `bind(value)` build lists.
- `query` runs **one** statement; a text holding more is refused before any of it runs
  (except on Durable Objects, which runs them all). A script goes through `exec`, which
  takes no parameters.
- `query("select … where id = $1", [id])` takes text and parameters too, in the dialect's
  placeholder style.
- A row is a plain object. `rowCount` is the rows returned, or the rows a plain write
  affected.
- Values bind by one rule on every adapter: on SQLite a boolean is `1`/`0`, a `Date` is
  ISO text and an array is refused (use `json()` or `inList()`); a plain object is JSON
  text on both. The table is in [API.md](./API.md#parameters).

## Transactions

```ts
const id = await db.transaction(async (tx) => {
	const { rows } = await tx.query(sql`insert into job (tenant) values (${tenant}) returning id`);
	await tx.query(sql`update tenant set job_count = job_count + 1 where name = ${tenant}`);
	return rows[0]?.id;
});
```

- Committed when the callback resolves, rolled back when it rejects.
- A statement belongs to the transaction whose callback issued it, and to no other. The
  `tx` the callback receives is the driver itself: inside the callback, `db.query` and
  `tx.query` are the same call.
- A nested `transaction` joins the open one.
- On Postgres a failed statement aborts the transaction: a callback that caught the error
  and resolved anyway gets a `TransactionAbortedError`, never a silent rollback. SQLite
  has no aborted state and commits the rest.
- `db.transaction(fn, { readOnly: true })` reads one snapshot and refuses a write, with a
  `ReadOnlyError`.
- `db.exclusive("name", fn)` runs `fn` holding a lock of that name. On Postgres it is an
  advisory lock every process on the database honours (`capabilities.crossProcessLock`);
  on SQLite, PGlite and Durable Objects it is a queue in this process.

### Savepoints

```ts
await db.transaction(async (tx) => {
	for (const row of rows) {
		try {
			await tx.savepoint((sp) => sp.query(insert("item", row)));
		} catch (error) {
			if (!(error instanceof UniqueViolationError)) throw error;
			skipped.push(row); // this row is undone, the rows before it stay
		}
	}
});
```

- `savepoint(fn)` runs `fn` as a unit of the open transaction: kept when it resolves,
  undone alone when it rejects, and the transaction goes on either way. On Postgres it is
  how a transaction survives a failed statement.
- Outside a transaction it is a transaction of its own. A library that is handed a driver
  calls it for an all-or-nothing unit, whether or not its caller opened a transaction.
- Savepoints nest. Two opened at once in one transaction run one after the other, and a
  statement the transaction issues while one is open waits for it to end.
- The same on every adapter: `SAVEPOINT` on SQLite and Postgres, the storage's nested
  transaction on Durable Objects. `db.sync` has it too.

## The sync tier

An async callback returns at its first `await`, so it cannot run inside a synchronous
transaction. Where the engine is synchronous (node:sqlite, Durable Objects), `db.sync` is
the same connection answering at once:

```ts
const count = db.sync?.transaction((tx) => {
	tx.query(sql`insert into job (tenant) values (${tenant})`);
	return tx.query<{ n: number }>(sql`select count(*) as n from job`).rows[0]?.n;
});
```

`db.sync.savepoint(fn)` is the savepoint with a synchronous callback.

The two tiers share one connection, so each refuses what would land in the wrong
transaction, with a `TypeError`: a sync callback that returns a promise, an async call
from inside a sync transaction or savepoint, and a sync call while an async transaction
is open, unless it comes from that transaction's own callback. The rules (S1–S6) are in
[API.md](./API.md#syncdriver).

## Errors

```ts
import { insert, UniqueViolationError } from "@marianmeres/sqlkit";

try {
	await db.query(insert("app_user", { email }));
} catch (error) {
	if (error instanceof UniqueViolationError) return conflict(error.constraint);
	throw error;
}
```

- What a database refused is a `SqlError` subclass, the same on every adapter:
  `UniqueViolationError`, `ForeignKeyViolationError`, `NotNullViolationError`,
  `CheckViolationError`, `SerializationError`, `DeadlockError`, `BusyError`,
  `ConnectionError`, `ReadOnlyError`, `TransactionAbortedError`, and `SqlError` itself
  for the rest. `kind` says the same as a string.
- The driver's error is `cause`, untouched; its message is the message. `constraint`,
  `table` and `columns` are filled where the database reported them.
- `retryable` is true for a serialization failure, a deadlock, a busy database and a lost
  connection.
- A programming mistake (a wrong argument, a refused call) is a `TypeError`, never a
  `SqlError`. What your own callback threw comes out as you threw it.
- `instanceof` holds across two copies of the package in one app, so an error thrown by
  a driver another package built is still caught by its class, and still retried by
  `withRetry`. Both copies have to be newer than 0.2.0.

## Statement builders

Functions that turn an object into a fragment. They hold nothing and run on either tier.

```ts
import { and, deleteFrom, inList, insert, raw, sql, update, upsert, whereEq } from "@marianmeres/sqlkit";

await db.query(insert("job", [{ tenant, status: "new" }, { tenant, status: "new" }]));
await db.query(update("job", { status: "done", updated_at: raw("now()") }, { id }));
await db.query(upsert("setting", { key, value }, { conflict: ["key"] }));
await db.query(deleteFrom("job", { tenant, id }, { returning: "*" }));

const filter = and(whereEq({ tenant, status }), sql`id in ${inList([1, 2, 3])}`);
await db.query(sql`select * from job where ${filter}`);
```

- A key whose value is `undefined` is left out of a row, a patch and a `whereEq`; `null`
  binds `NULL` and, in a match, reads `is null`. A fragment value is spliced.
- `update` and `deleteFrom` require a `where`, and their match object refuses an
  `undefined` value, which would widen the write. Touching every row is spelled
  `raw("true")`; `whereEq(match)` as the `where` says that dropping a key is meant.
- `upsert` overwrites every written column not in `conflict` by default; `update: []`
  keeps the existing row (`do nothing`).

## Row decoders

Drivers hand back what the database stores: SQLite has no boolean, instant or JSON type,
and node-postgres reads `int8` as a string. Decoding is opt-in, per column:

```ts
import { decode, decodeRows } from "@marianmeres/sqlkit";

const { rows } = await db.query(sql`select id, active, created_at, data from job`);
const jobs = decodeRows(rows, {
	active: decode.bool,
	created_at: decode.instant,
	data: decode.json,
});
```

`decode.bool`, `decode.instant`, `decode.json`, `decode.bigint` and `decode.number` read
`null` as `null` and refuse anything else they cannot read with a `TypeError` naming the
column, never the value.

## Retry and health

```ts
import { createHealthMonitor, withRetry } from "@marianmeres/sqlkit";

// Runs the whole transaction again on a serialization failure, a deadlock, a busy
// database or a lost connection: 3 retries, waits from 100 ms, doubling, at most 5 s.
await withRetry(() => db.transaction(async (tx) => { /* … */ }));

const monitor = createHealthMonitor(db, {
	intervalMs: 30_000,
	onChange: (status) => console.log(status.healthy ? "db up" : "db down", status.error),
});
await monitor.start(); // resolves after the first check
monitor.last(); // { healthy, latencyMs, error, checkedAt }
```

`checkHealth(db)` is one check: a `select 1`, never rejecting, unhealthy after
`timeoutMs` (5 s) without an answer.

## Migrations

```ts
import { createMigrate } from "@marianmeres/sqlkit/migrate";
import { addSqlFiles } from "@marianmeres/sqlkit/migrate/files";

const migrate = createMigrate(db);
migrate.addVersion(
	"1.0.0",
	({ db }) => db.exec("create table job (id integer primary key, tenant text)"),
	({ db }) => db.exec("drop table job"),
);
await addSqlFiles(migrate, "./migrations"); // 1.1.0__add_status.up.sql, 1.1.0.down.sql, …
await migrate.up();
```

- `createMigrate` is an [`@marianmeres/migrate`](https://www.npmjs.com/package/@marianmeres/migrate)
  instance whose run lock, steps and version table are the driver's. A worker receives the
  driver as `db`; what it issues runs inside its step, and is undone with it.
- A step that fails is undone alone, and the steps before it stay, on every adapter.
- `addSqlFiles` (Node only) registers `<version>[__<label>].up.sql` and `.down.sql` files;
  each file is one `exec`, so it may hold several statements. A version with no down file
  is irreversible.
- The version table and the lock name are the migrate package's own, so its Postgres and
  SQLite helpers can continue a database this wiring migrated, and the reverse.

## Testing your app

- **Do not use SQLite as a stand-in for Postgres.** Types, coercion, constraints,
  collation and dates differ, and a test that passes there proves little about
  production.
- **For an in-memory Postgres, use PGlite** (`@marianmeres/sqlkit/pglite`): the real
  Postgres parser and planner, in your process, no server. Or a real Postgres with a
  schema per test (`createPgDriver(pool, { schema })`).
- Your app's code takes a `Driver`, so the test hands it the PGlite one and production the
  pool.

## Before you rely on it

- **A single connection can wait for itself.** On node:sqlite, one `pg.Client`, PGlite and
  Durable Objects, a statement issued during a transaction from a context that lost it (a
  callback handed to an event emitter, or to a queue created outside the transaction)
  waits for the transaction, and the transaction waits for it. The context follows
  `await`; bind such a callback inside the transaction (`AsyncLocalStorage.bind`). A pool
  does not wait, but that statement runs outside the transaction there too.
- **A savepoint can wait for itself the same way,** on every adapter, a pool included.
  What a transaction issues while a savepoint is open waits for the savepoint, so a
  savepoint's callback must not await a statement that was issued outside it.
- **`withRetry` runs the whole function again.** Put it around one idempotent statement
  or a whole `transaction` call, never around part of a transaction: on Postgres the
  transaction is already aborted, and anywhere the statements before the failure are
  still in it.
- **Migrations lock in one of two ways.** Where the driver's lock crosses processes
  (`createPgDriver`, `createPgClientDriver`) a run holds an advisory lock and each step is
  a transaction of its own. Elsewhere (node:sqlite, PGlite, Durable Objects) the run is
  one transaction and each step a savepoint of it, so a long run holds the database's
  write lock for its whole length. Either way a failed step is undone alone. Up to 0.2.0
  it undid the whole run on the second kind.
- **One active version is stored, not a ledger of applied steps.** `up()` runs the
  versions above the active one, in semver order. A version added later _below_ the
  active one is never applied, and never reported as pending.

## API

See [API.md](./API.md) for every export of every entry point.

## License

[MIT](./LICENSE)
