# API

Every export of every entry point. Each entry point is its own subpath export:

| Entry point                                                           | Holds                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@marianmeres/sqlkit`](#marianmeressqlkit)                           | fragments, the driver contract, parameters, errors, builders, decoders, retry, health      |
| [`@marianmeres/sqlkit/sqlite`](#marianmeressqlkitsqlite)              | the node:sqlite adapter, with the sync tier                                                |
| [`@marianmeres/sqlkit/pg`](#marianmeressqlkitpg)                      | the node-postgres adapter: over a pool, over one client, or whichever a library was handed |
| [`@marianmeres/sqlkit/pglite`](#marianmeressqlkitpglite)              | the PGlite adapter                                                                         |
| [`@marianmeres/sqlkit/do`](#marianmeressqlkitdo)                      | the Durable Objects adapter, with the sync tier                                            |
| [`@marianmeres/sqlkit/migrate`](#marianmeressqlkitmigrate)            | `@marianmeres/migrate` wired over a `Driver`                                               |
| [`@marianmeres/sqlkit/migrate/files`](#marianmeressqlkitmigratefiles) | SQL files as migration versions (Node only)                                                |

Two rules hold across all of them:

- A database failure is a [`SqlError`](#sqlerror) subclass, with the driver's error as
  `cause`. A programming mistake (an argument or an option of the wrong type, a call the
  contract refuses) is a `TypeError`, never wrapped. What a caller's own callback threw
  comes out as it was thrown.
- No adapter imports its driver library. The host builds the client; the adapter declares
  the shape it takes structurally (`PgPoolLike`, `PgliteLike`, `DoStorageLike`), so the
  package has no peer dependency.

---

## `@marianmeres/sqlkit`

The root entry point: runtime-neutral. It imports nothing from `node:*` and no driver, so
it loads in a Worker as well as in Node.

### Fragments

A fragment is SQL text with its bound values, kept apart until `render` writes the
placeholders in the dialect's style (`$1 … $n` on `pg`, `?` on `sqlite`). Interpolating a
fragment into another splices its text and its values, so nothing is numbered by hand and
no value is escaped into the text.

Only a fragment one of these functions built is spliced. It is marked with a
non-enumerable `Symbol.for` key that JSON cannot carry, so an object that merely looks like
one (a parsed request body `{ "kind": "sql", "chunks": […] }`) is bound as a value.

#### `` sql`…` ``

Tagged template for a fragment. An interpolated fragment is spliced; anything else is
bound as one value. An array is one value too, never expanded into a list (see
[`inList`](#inlistvalues)). A template chunk with an invalid escape sequence is a
`TypeError`.

**Returns:** `Sql`

```ts
const where = sql`tenant_id = ${tenantId}`;
const statement = sql`select * from ${ident("app", "job")} where ${where} limit ${10}`;
render(statement, "pg");
// { text: 'select * from "app"."job" where tenant_id = $1 limit $2', params: [tenantId, 10] }
```

#### `raw(text)`

Literal SQL text with no bound values. The caller owns its safety: use it for SQL the code
itself owns (`raw("now()")`), never for input.

**Returns:** `Sql`

#### `bind(value)`

One bound value on its own, for composing into a larger fragment, such as a list for
`join`.

**Returns:** `Sql`

#### `join(parts, separator?)`

Concatenates fragments with a literal separator.

- `parts` (`readonly Sql[]`): anything that is not a fragment is a `TypeError`; wrap a
  value in `bind`.
- `separator` (`string`, optional): default `", "`.

**Returns:** `Sql`. `join([])` is `EMPTY`.

```ts
const columns = join(["id", "name"].map((name) => ident(name)));
const values = join([1, 2, 3].map(bind));
sql`select ${columns} from t where id in (${values})`;
```

#### `ident(...path)`

A quoted identifier, one argument per segment: `ident("public", "job")` is
`"public"."job"`. A segment is never split on a dot, so `ident("a.b")` names one object
called `a.b`. No argument, an empty name or a NUL character is a `TypeError`.

**Returns:** `Sql`

#### `json(value)`

One JSON value, bound as its JSON text, which both databases read into a JSON column.
`null` and `undefined` bind SQL `NULL`, not the JSON `null`. A value with no JSON form (a
function, a symbol), a `bigint` and a cycle are a `TypeError`.

**Returns:** `Sql`

```ts
await db.query(sql`insert into event (payload) values (${json({ type: "login", tags: ["a"] })})`);
```

#### `render(fragment, dialect)`

The text and the parameter array a driver's query takes. Values become placeholders in
order: `$1 … $n` for `"pg"`, `?` for `"sqlite"`. Adapters call it; a host rarely needs to.

- `fragment` (`Sql`): a fragment built here; anything else is a `TypeError`.
- `dialect` (`"pg" | "sqlite"`)

**Returns:** `{ text: string; params: unknown[] }`. The values are not yet bound by the
[parameter rule](#parameters).

#### `isSql(value)`

Whether `value` is a fragment one of these functions built (by its brand, not its shape).

**Returns:** `boolean`

#### `EMPTY`

The empty fragment, frozen. `join([])` returns it; `and()` and `or()` with nothing left
return it.

#### `quoteIdent(name)`

`"we""ird"`: one identifier, double-quoted, an embedded double quote doubled, as text. An
empty name or a NUL character is a `TypeError`. `ident` is the fragment form.

**Returns:** `string`

#### `quoteLiteral(value)`

`'it''s'`: a string literal, for SQL text that must embed one (a DDL default, a JSON path
in an expression). A bound value is the right tool everywhere else. A NUL character is a
`TypeError`.

**Returns:** `string`

#### `Sql`

```ts
interface Sql {
	readonly kind: "sql";
	readonly chunks: readonly string[]; // chunks.length === values.length + 1
	readonly values: readonly unknown[];
}
```

A fragment. An object literal of this shape is not one: build it with `sql`, `raw`,
`bind`, `join`, `ident` or `json`.

### The driver contract

#### `Driver`

A database, asynchronously. Every adapter's factory returns one.

```ts
interface Driver {
	readonly dialect: DialectName;
	readonly adapter: string; // "node:sqlite", "pg", "pg-client", "pglite", "durable-objects"
	readonly capabilities: Capabilities;
	query<T = Row>(statement: Sql): Promise<QueryResult<T>>;
	query<T = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
	exec(script: string): Promise<void>;
	transaction<T>(fn: (tx: Driver) => Promise<T>, options?: TransactionOptions): Promise<T>;
	savepoint<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
	exclusive<T>(name: string, fn: (tx: Driver) => Promise<T>): Promise<T>;
	close(): Promise<void>;
	readonly sync?: SyncDriver;
}
```

| Member                     | What it does                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query(statement)`         | Runs one statement, a fragment. A text of several statements is refused before any of it runs.                                                                                                                                                                 |
| `query(text, params?)`     | The same with SQL text and its parameters, in the dialect's placeholder style. Parameters given with a fragment are a `TypeError`.                                                                                                                             |
| `exec(script)`             | Runs a script: any number of statements, no parameters, no result. Inside an open transaction it is part of it.                                                                                                                                                |
| `transaction(fn, options)` | Runs `fn` in one transaction: committed when it resolves, rolled back when it rejects. A nested call joins the open transaction as it is, whatever its options ask for.                                                                                        |
| `savepoint(fn)`            | Runs `fn` as a unit that is kept or undone as a whole. Inside an open transaction it is a savepoint of it: kept when `fn` resolves, rolled back to when it rejects, and the transaction goes on. Outside one it is `transaction(fn)`.                          |
| `exclusive(name, fn)`      | Runs `fn` holding the lock `name`, which every other caller with that name waits for: in this process and, where `capabilities.crossProcessLock` is true, in every process on the database. Re-entrant. Inside an open transaction, that transaction holds it. |
| `close()`                  | Ends the client the adapter was given. Idempotent. Inside a transaction it rejects with a `TypeError`, and on a pool inside an `exclusive` section too: it would wait for the callback that awaits it.                                                         |
| `sync`                     | The [synchronous tier](#syncdriver), on an adapter whose engine is synchronous.                                                                                                                                                                                |

The callback of `transaction`, `savepoint` and `exclusive` receives the driver itself:
which transaction a statement is in is decided by the async context it was issued from,
not by the handle. The rules every adapter is held to:

| Rule | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1   | `query` and `exec` always answer with a promise: a failing statement rejects, it never throws at the call.                                                                                                                                                                                                                                                                                                                                                                                                   |
| R2   | `rowCount` is as `QueryResult` says, for a `SELECT`, a plain write and a write with `RETURNING`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| R3   | `transaction` commits when `fn` resolves and rolls back when it rejects. On `pg` a callback that swallowed a failed statement gets a `TransactionAbortedError`; SQLite commits the rest.                                                                                                                                                                                                                                                                                                                     |
| R4   | A nested `transaction` joins the open one, as it was opened.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R5   | A statement belongs to the transaction whose callback issued it, and to no other: one from elsewhere neither sees its uncommitted rows nor goes with its rollback.                                                                                                                                                                                                                                                                                                                                           |
| R6   | "Inside" ends when the callback settles: a promise that outlives its transaction writes outside it.                                                                                                                                                                                                                                                                                                                                                                                                          |
| R7   | `readOnly` reads one snapshot and refuses a write.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R8   | `exclusive` serializes callers of one name, is re-entrant, lets two names run together, releases on rejection, and inside an open transaction belongs to that transaction.                                                                                                                                                                                                                                                                                                                                   |
| R9   | `exec` runs every statement of a script and joins the open transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R10  | Parameters follow the [parameter rule](#parameters). Rows are plain objects. Bytes read back as a `Uint8Array`.                                                                                                                                                                                                                                                                                                                                                                                              |
| R11  | `query` runs one statement: a text holding more is refused before any of it runs. Blanks, semicolons and comments after it are not a statement. A script goes through `exec`. Not on [Durable Objects](#marianmeressqlkitdo), which runs them all.                                                                                                                                                                                                                                                           |
| R12  | `savepoint` runs `fn` as a unit of the open transaction: kept when `fn` resolves, undone alone when it rejects, and the transaction goes on either way. Savepoints nest, and two opened at once run one after the other. A statement issued in the transaction from outside the savepoint's callback waits for the savepoint to end. On `pg` a callback that swallowed a failed statement gets a `TransactionAbortedError`, and the savepoint is undone. Outside a transaction a savepoint is a transaction. |

```ts
const id = await db.transaction(async (tx) => {
	const { rows } = await tx.query<{ id: number }>(
		sql`insert into job (tenant) values (${tenant}) returning id`,
	);
	return rows[0]?.id;
});

await db.exclusive("nightly-report", async () => {
	// one process at a time, where capabilities.crossProcessLock is true
});
```

A savepoint is for a step that may fail inside work that is to stay:

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

- On Postgres a failed statement aborts the transaction it is in, so without the
  savepoint the loop above could not go on: rolling back to it is what lifts that.
- Code that is handed a driver, and cannot know whether its caller opened a transaction,
  calls `savepoint` for a unit of its own: a savepoint of the caller's transaction when
  there is one, a transaction when there is none.
- A savepoint is exclusive in the transaction it was opened in. A second one opened there
  before the first ended waits for it, and so does a statement the transaction issues
  meanwhile, so `Promise.all` over several is safe and runs them in order. A savepoint's
  callback must not await such a statement: it waits for the savepoint.
- A transaction, and a savepoint, ends only once the savepoints opened in it have, awaited
  or not. A promise that outlives its savepoint runs what it issues afterwards in the
  transaction, outside the savepoint.
- The names `sqlkit_1`, `sqlkit_2`, … are the driver's, one per depth. A savepoint written
  by hand (`savepoint mine` through `query`) works beside them under any other name, on
  every adapter but Durable Objects.

#### `SyncDriver`

```ts
interface SyncDriver {
	readonly dialect: DialectName;
	readonly adapter: string;
	readonly capabilities: Capabilities;
	query<T = Row>(statement: Sql): QueryResult<T>;
	query<T = Row>(text: string, params?: readonly unknown[]): QueryResult<T>;
	exec(script: string): void;
	transaction<T>(fn: (tx: SyncDriver) => T, options?: TransactionOptions): T;
	savepoint<T>(fn: (tx: SyncDriver) => T): T;
}
```

A database, synchronously: `driver.sync`, on an adapter whose engine is synchronous
underneath (node:sqlite, Durable Objects). Its transaction callback is synchronous, which
is the point of it: an async callback returns at its first `await` and would leave the
transaction open. It is the same connection as the async tier, so the two refuse each
other where a call would land in the wrong transaction. A refused sync call throws its
`TypeError` at the call; a database failure throws its `SqlError`.

`savepoint(fn)` is [`Driver.savepoint`](#driver) with a synchronous callback: a savepoint
of the open transaction, kept when `fn` returns and undone alone when it throws, and a
transaction of its own when none is open.

| Rule | Behaviour                                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | A transaction or savepoint callback that returns a thenable is undone, with a `TypeError`.                                                                                                                     |
| S2   | A nested `transaction` joins the open one, as it was opened.                                                                                                                                                   |
| S3   | A sync call from inside an open async transaction's own callback runs inside that transaction; a sync `savepoint` there is a savepoint of it.                                                                  |
| S4   | A sync call while an async transaction is open, from anywhere else, is a `TypeError`. So is one from inside that transaction while a savepoint opened there is running, from outside the savepoint's callback. |
| S5   | An async call from inside a sync transaction's or savepoint's callback rejects with a `TypeError`: it could only run after the callback returned.                                                              |
| S6   | With no transaction open, a sync call runs at once, ahead of queued async work.                                                                                                                                |

```ts
const n = db.sync?.transaction((tx) => {
	tx.query(sql`insert into job (tenant) values (${tenant})`);
	return tx.query<{ n: number }>(sql`select count(*) as n from job`).rows[0]?.n;
});
```

#### `QueryResult`

```ts
interface QueryResult<T = Row> {
	rows: T[];
	rowCount: number;
}
```

`rowCount` is the rows returned, for a statement that returns rows (a `SELECT`, a write
with `RETURNING`), and the rows affected, for a plain `INSERT`, `UPDATE` or `DELETE`. For
any other statement (DDL, a `SET`, a pragma) it is a number and nothing more.

#### `TransactionOptions`

```ts
interface TransactionOptions {
	readonly readOnly?: boolean; // default false
}
```

`readOnly: true` reads one consistent snapshot and writes nothing; a write is a
`ReadOnlyError`. Postgres opens `REPEATABLE READ READ ONLY`. SQLite opens a deferred
`BEGIN` (no write lock: another connection keeps writing) with `query_only` on. Anything
but a boolean is a `TypeError`.

#### `Capabilities`

```ts
interface Capabilities {
	readonly sync: boolean; // driver.sync exists
	readonly concurrentWriters: boolean; // more than one connection
	readonly crossProcessLock: boolean; // exclusive() excludes other processes too
}
```

What an adapter's dialect does not already tell.

| `adapter`           | `sync` | `concurrentWriters` | `crossProcessLock` |
| ------------------- | ------ | ------------------- | ------------------ |
| `"node:sqlite"`     | true   | false               | false              |
| `"pg"`              | false  | true                | true               |
| `"pg-client"`       | false  | false               | true               |
| `"pglite"`          | false  | false               | false              |
| `"durable-objects"` | true   | false               | false              |

#### `DialectName`

```ts
type DialectName = "pg" | "sqlite";
```

The SQL a driver speaks. It decides the placeholder style and what a value binds as.

#### `Row`

```ts
type Row = Record<string, unknown>;
```

A row as a driver hands it back: a plain object, one property per selected column.

#### `isDriver(value)`

Whether `value` is a `Driver`: what a library asks when its `db` option takes a driver or
something else (a pool, a database handle), before it decides which it was handed.

By its shape, not by a mark: `Driver` is an interface, so one built by another copy of
this package, or by an adapter written outside it, is a driver all the same. The shape is
the contract as this version states it, every member of it: `dialect` (`"pg"` or
`"sqlite"`), `adapter`, the three `capabilities`, the six methods, and a `sync` tier's four
when there is one. So a driver built before `savepoint` was added is not one, as the type
would not take it either, and neither is a `SyncDriver`.

**Returns:** `boolean`; it narrows `value` to `Driver`.

```ts
import { isDriver } from "@marianmeres/sqlkit";
import { createSqliteDriver } from "@marianmeres/sqlkit/sqlite";

// `options.db` is a `DatabaseSync` or a `Driver`. Decided once, where the library is set
// up: a handle gets one driver, not one per call.
const db = isDriver(options.db) ? options.db : createSqliteDriver(options.db);
```

For node-postgres, [`toPgDriver`](#topgdriverdb) decides between a pool, a client and a
driver in one call.

### Parameters

One rule, applied by every adapter before a value reaches its driver, so that a value means
the same on every database:

| Value                                      | `pg`                     | `sqlite`                                |
| ------------------------------------------ | ------------------------ | --------------------------------------- |
| `undefined`, `null`                        | `NULL`                   | `NULL`                                  |
| `boolean`                                  | as is                    | `1` / `0`                               |
| `Date`                                     | as is                    | `toISOString()`                         |
| `bigint`, `number`, `string`, `Uint8Array` | as is                    | as is                                   |
| plain object                               | `JSON.stringify`         | `JSON.stringify`                        |
| array                                      | as is (a Postgres array) | `TypeError`: use `json()` or `inList()` |
| anything else                              | `TypeError`              | `TypeError`                             |

A plain object is one whose prototype is `Object.prototype` or `null`; a `Map`, a class
instance or a typed array other than `Uint8Array` is "anything else". An invalid `Date` and
a fragment passed as a parameter are a `TypeError` on both dialects. Reading values back is
opt-in, per column: see [decoders](#row-decoders).

#### `normalizeParam(value, dialect)`

One value, bound by the rule for `dialect`. Adapters call it; a host rarely needs to.

**Returns:** `unknown`, what the driver is handed.

#### `normalizeParams(params, dialect)`

Every value of `params`, bound by the rule. A new array; the input is kept.

**Returns:** `unknown[]`

### Adapter helpers

What every adapter calls before a statement reaches its database. Exported for an adapter
written outside this package.

#### `statementOf(statement, params, dialect)`

The text and the parameters of one `query` call. A fragment is rendered; text is passed
through with a copy of its parameters. Parameters given together with a fragment, a
statement that is neither, and parameters that are not an array are a `TypeError`. The
values are not yet bound by the parameter rule.

**Returns:** `{ text: string; params: unknown[] }`

#### `readOnlyOf(options)`

Whether a `TransactionOptions` asks for a read-only transaction. A `readOnly` that is not a
boolean is a `TypeError`.

**Returns:** `boolean`

#### `assertLockName(name)`

Refuses an `exclusive` lock name that is not a non-empty string, with a `TypeError`: an
empty or missing name would quietly make every caller share one lock.

**Returns:** nothing; it asserts `name is string`.

### Errors

#### `SqlError`

```ts
class SqlError extends Error {
	readonly kind: SqlErrorKind;
	readonly dialect: DialectName;
	readonly code: string | undefined;
	readonly constraint: string | undefined;
	readonly table: string | undefined;
	readonly columns: readonly string[] | undefined;
	get retryable(): boolean;
	constructor(message: string, dialect: DialectName, info: SqlErrorInfo, cause?: unknown);
}
```

A statement or a connection the database refused, thrown by every adapter in place of its
driver's error. The driver's error is `cause`, untouched, and its message is the message.
`code` is the SQLSTATE on `pg` (or Node's code, such as `ECONNRESET`, for a lost socket),
SQLite's extended result code in decimal on `sqlite`. `constraint`, `table` and `columns`
are filled only where the database reported them. `retryable` is true for the kinds
`serialization`, `deadlock`, `busy` and `connection`. A kind or a dialect the constructor
does not know is a `TypeError`.

Catch a subclass, or read `kind`. Each subclass is built by [`toSqlError`](#tosqlerrorerror-dialect-classify)
for its kind; `SqlError` itself is `unknown`, everything no classifier recognized.

`instanceof` holds across copies of the package. An app whose dependencies ask for two
`0.x` minors runs two copies, each with classes of its own, so every `SqlError` carries a
mark (a `Symbol.for` key, on its prototype) that `instanceof` reads: an error another
copy built is a `SqlError` here, and an instance of the subclass of its `kind`. That is
what lets `withRetry` retry, and a `catch` branch take, an error thrown by a driver that
another package built. An error this copy built is what its prototype chain says: one
built by hand as the base class is not the subclass of its kind, and a class you declare
yourself has only its own instances. A copy of 0.2.0 or older has no mark: its errors
are recognized by itself alone.

| Class                      | `kind`          | What happened                                                                     | Retryable |
| -------------------------- | --------------- | --------------------------------------------------------------------------------- | --------- |
| `UniqueViolationError`     | `unique`        | a duplicate of a unique index or a primary key                                    |           |
| `ForeignKeyViolationError` | `foreign_key`   | a reference to a row that is not there, or a delete of one referenced             |           |
| `NotNullViolationError`    | `not_null`      | `NULL` written to a `NOT NULL` column                                             |           |
| `CheckViolationError`      | `check`         | a row a `CHECK` constraint refused                                                |           |
| `SerializationError`       | `serialization` | a concurrent transaction won (Postgres `40001`)                                   | yes       |
| `DeadlockError`            | `deadlock`      | chosen as a deadlock's victim (Postgres `40P01`)                                  | yes       |
| `BusyError`                | `busy`          | a lock was not granted in time (SQLite busy or locked, Postgres `55P03`)          | yes       |
| `ConnectionError`          | `connection`    | the connection could not be made or was lost                                      | yes       |
| `ReadOnlyError`            | `read_only`     | a write in a read-only transaction or to a read-only database                     |           |
| `TransactionAbortedError`  | `aborted`       | a statement, or a `COMMIT`, in a transaction a failure already aborted (Postgres) |           |

What each database reports beside the kind:

| Kind          | `pg`                  | `sqlite`                                                       |
| ------------- | --------------------- | -------------------------------------------------------------- |
| `unique`      | `constraint`, `table` | `table`, `columns`; `constraint` for an index on an expression |
| `foreign_key` | `constraint`, `table` | nothing                                                        |
| `not_null`    | `table`, `columns`    | `table`, `columns`                                             |
| `check`       | `constraint`, `table` | `constraint` for a named `CHECK`                               |

```ts
try {
	await db.query(insert("app_user", { email }));
} catch (error) {
	if (error instanceof UniqueViolationError) return { conflict: error.constraint ?? error.columns };
	throw error;
}
```

#### `SqlErrorKind`

```ts
type SqlErrorKind =
	| "unique" | "foreign_key" | "not_null" | "check"
	| "serialization" | "deadlock" | "busy" | "connection"
	| "read_only" | "aborted" | "unknown";
```

#### `SqlErrorInfo`

```ts
interface SqlErrorInfo {
	kind: SqlErrorKind;
	code?: string;
	constraint?: string;
	table?: string;
	columns?: readonly string[];
}
```

What a classifier read from a driver error. Every field but `kind` is filled only where
the database reported it.

#### `toSqlError(error, dialect, classify)`

A driver's error as a `SqlError`: classified by `classify`, built as the subclass of its
kind, with the driver's message and the driver's error as `cause`. Idempotent: a
`SqlError` passes through as it is. What an adapter calls at its boundary.

- `error` (`unknown`): what the driver threw.
- `dialect` (`DialectName`)
- `classify` (`(error: unknown) => SqlErrorInfo`): `classifyPg` or `classifySqlite`.

**Returns:** `SqlError`

#### `classifyPg(error)`

Which kind a Postgres driver's error is, read by its shape: the SQLSTATE in `code`, and
`constraint`, `table` and `column` where the server sent them, as node-postgres (and
PGlite) name them. A lost socket's Node code (`ECONNRESET`, …), SQLSTATE class `08`, and
node-postgres's connection timeout and terminated connection read as `connection`.

**Returns:** `SqlErrorInfo`

#### `classifySqlite(error)`

Which kind a SQLite driver's error is, by its extended result code (node:sqlite's
`errcode`), with the subject parsed from the message, since SQLite reports no constraint
fields. An error with no `errcode` is read from the code names its message ends with, as a
Durable Object's errors carry them (`…: SQLITE_CONSTRAINT (extended:
SQLITE_CONSTRAINT_UNIQUE)`): the most specific name gives the kind and the code. An error
with neither did not come from SQLite and is `unknown`.

**Returns:** `SqlErrorInfo`

### Statement builders

Functions that turn an object into the fragment of an `INSERT`, `UPDATE`, upsert or
`DELETE`, and the `WHERE` pieces those take. Each returns a `Sql` and holds nothing; either
tier executes it. The statements are the subset both dialects share (`INSERT … VALUES`,
`ON CONFLICT`, `RETURNING`). There is no `select` builder: a query is what `sql` is for.

The rules, the same in every builder:

1. A key whose value is `undefined` is left out of a row, a patch and a `whereEq`. In the
   match object `update` and `deleteFrom` take, it is a `TypeError`: left out there, it
   would widen a write. `null` binds `NULL`, and in a match reads `is null`. A value that
   is a fragment is spliced, so `{ updated_at: raw("now()") }` writes the expression.
2. Nothing left to write is a `TypeError`: an empty row, patch, match or `inList`.
3. A multi-row `insert` takes its columns from the first row; a row whose keys differ is a
   `TypeError`. Key order may differ.
4. `update` and `deleteFrom` require a `where`; an empty one is a `TypeError`. Touching
   every row is spelled `raw("true")`.
5. Every identifier goes through `ident`; every value is bound.

`options.returning` is `"*"` or a non-empty array of column names.

#### `insert(table, rows, options?)`

`insert into "t" ("a", "b") values ($1, $2), ($3, $4)`.

- `table` (`TableRef`)
- `rows` (`Match | readonly Match[]`): one row, or several with the same keys.
- `options.returning` (`Returning`, optional)

**Returns:** `Sql`

```ts
await db.query(insert("job", { tenant, payload: json(data) }, { returning: ["id"] }));
await db.query(insert("job", [{ tenant, n: 1 }, { tenant, n: 2 }]));
```

#### `update(table, patch, where, options?)`

`update "t" set "a" = $1 where …`.

- `table` (`TableRef`)
- `patch` (`Match`): the columns to set.
- `where` (`Sql | Match`): a fragment, or a match read as `whereEq` reads it, except that
  an `undefined` value is a `TypeError`. Required.
- `options.returning` (`Returning`, optional)

**Returns:** `Sql`

```ts
await db.query(update("job", { status: "done", updated_at: raw("now()") }, { id }));
await db.query(update("job", { status: "stale" }, sql`created_at < ${cutoff}`));
```

#### `upsert(table, row, options)`

`insert into "t" (…) values (…) on conflict ("id") do update set "a" = excluded."a"`.

- `table` (`TableRef`)
- `row` (`Match`): one row; an array is a `TypeError`.
- `options.conflict` (`readonly string[]`): the unique columns a clash is detected on;
  required and non-empty.
- `options.update` (`readonly string[]`, optional): the columns a clash overwrites with the
  new row's values. Default: every written column not in `conflict`. With none, or `[]`,
  a clash keeps the existing row: `do nothing`.
- `options.returning` (`Returning`, optional)

**Returns:** `Sql`

```ts
await db.query(upsert("setting", { key, value }, { conflict: ["key"] }));
```

#### `deleteFrom(table, where, options?)`

`delete from "t" where …`. `where` is required, as in `update`.

**Returns:** `Sql`

```ts
await db.query(deleteFrom("job", { tenant, id }));
await db.query(deleteFrom("job", whereEq({ tenant, status }))); // an undefined status is dropped
```

#### `whereEq(match)`

`"a" = $1 and "b" is null`: one equality per key, joined by `and`. `null` reads `is null`;
a fragment value is spliced; an `undefined` key is left out, which suits a filter built
from optional inputs; a match with nothing left is a `TypeError`.

**Returns:** `Sql`

#### `and(...parts)`, `or(...parts)`

`(a) and (b)`, `(a) or (b)`: each part parenthesized. Empty parts are skipped; with none
left, `EMPTY`. A part that is not a fragment is a `TypeError`.

**Returns:** `Sql`

```ts
const filter = and(whereEq({ tenant }), status ? sql`status = ${status}` : EMPTY);
```

#### `inList(values)`

`($1, $2, $3)`: a parenthesized list for `in`, one bound value each, a fragment spliced.
An empty list is a `TypeError`: `in ()` is not SQL on Postgres.

**Returns:** `Sql`

```ts
await db.query(sql`select * from job where id in ${inList(ids)}`);
```

#### `TableRef`, `Returning`, `Match`

```ts
type TableRef = string | Sql; // a string is one quoted identifier; ident("app", "job") names a schema
type Returning = "*" | readonly string[];
type Match = Record<string, unknown>; // column names to values
```

### Row decoders

Drivers hand back what the database stores: SQLite has no boolean, instant or JSON type,
and node-postgres reads `int8` and `numeric` as strings. Decoding is opt-in and per column,
since decoding automatically would need a declared schema.

#### `decode`

The built-in decoders, frozen. Each reads `null` and `undefined` as `null`, and refuses
anything else it cannot read with a `TypeError` naming the column and the type it found,
never the value.

| Decoder          | Accepts                                                                                                                   | Returns           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `decode.bool`    | `true`/`false`, `1`/`0`, `1n`/`0n`, `"t"`/`"f"`, `"true"`/`"false"`, `"1"`/`"0"`                                          | `boolean \| null` |
| `decode.instant` | a valid `Date`, a string `Date` parses, epoch milliseconds. A date and time with no offset (`2026-01-02 03:04:05`) is UTC | `Date \| null`    |
| `decode.json`    | a string, parsed as JSON; any other value as it is                                                                        | `unknown`         |
| `decode.bigint`  | a `bigint`, an integer `number`, a string of digits with an optional sign                                                 | `bigint \| null`  |
| `decode.number`  | a `number`, `bigint` or decimal string that is finite and, if an integer, safe                                            | `number \| null`  |

`decode.instant` reads a date and time with no offset as UTC because that is how SQLite's
`CURRENT_TIMESTAMP`, `datetime()` and `strftime()` write it. `decode.json` parses every
string: on `pg`, where a `json` or `jsonb` column arrives parsed, a column whose JSON value
is itself a string is parsed a second time. It is for columns of objects and arrays.

#### `decodeRow(row, spec)`

A new row with the columns `spec` names decoded, every other column as it was. A column
`spec` names that the row does not have is a `TypeError`: a driver hands back every column
it selected, so a missing one is a spec that does not match its query.

- `row` (`Row`)
- `spec` (`Record<string, Decoder<unknown>>`): column names to decoders.

**Returns:** `Row & { [K in keyof S]: ReturnType<S[K]> }`

#### `decodeRows(rows, spec)`

`decodeRow` over every row: a new array of new rows.

**Returns:** `Array<Row & { [K in keyof S]: ReturnType<S[K]> }>`

```ts
const { rows } = await db.query(sql`select id, active, created_at, data from job`);
const jobs = decodeRows(rows, {
	active: decode.bool,
	created_at: decode.instant,
	data: decode.json,
});
```

#### `Decoder`

```ts
type Decoder<T> = (value: unknown, column: string) => T;
```

A decoder of your own has this shape: return the value, or throw a `TypeError`.

### Retry

#### `withRetry(fn, options?)`

Runs `fn`, and runs it again while it rejects with a retryable error, up to
`options.retries` times, waiting longer before each call. Resolves with the first call
that resolves; rejects with the last error, untouched, once it is not retryable or no retry
is left. `fn` receives the number of the call, 1 for the first.

It runs the whole function again, so it belongs around something safe to run twice: one
idempotent statement, or a whole `transaction` call. Never around part of a transaction.

- `fn` (`(attempt: number) => Promise<T>`)
- `options` (`RetryOptions`, optional): checked before the first call; a wrong one is a
  `TypeError` (a rejection).

**Returns:** `Promise<T>`

```ts
const user = await withRetry(
	() => db.transaction(async (tx) => { /* … */ }),
	{ retries: 5, onRetry: ({ attempt, delayMs, error }) => log.warn({ attempt, delayMs, error }) },
);
```

#### `RetryOptions`

| Option           | Type                                                                   | Default                                        | Meaning                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `retries`        | `number`                                                               | `3`                                            | how many times to run `fn` again after the first call fails; a non-negative integer                                            |
| `initialDelayMs` | `number`                                                               | `100`                                          | the wait before the first retry                                                                                                |
| `maxDelayMs`     | `number`                                                               | `5_000`                                        | the longest wait between two calls                                                                                             |
| `factor`         | `number`                                                               | `2`                                            | what each wait is multiplied by for the next one; finite, at least 1                                                           |
| `retryable`      | `(error: unknown) => boolean`                                          | `error instanceof SqlError && error.retryable` | whether `error` is worth another call                                                                                          |
| `onRetry`        | `(info: { attempt: number; delayMs: number; error: unknown }) => void` | none                                           | called before each wait; `attempt` is the call that failed                                                                     |
| `signal`         | `AbortSignal`                                                          | none                                           | aborting it ends the run with its reason, at once, during a wait, or instead of a retry; a call in progress is not interrupted |

The wait before retry `n` is `initialDelayMs * factor ** (n - 1)`, at most `maxDelayMs`.
The delays are from 0 to 2^31 − 1 ms. A hook that throws ends the run with what it threw.

### Health

#### `checkHealth(db, options?)`

Checks once that `db` answers: one `select 1`, timed on the monotonic clock. Never
rejects: a refusal is an unhealthy status whose `error` is a `SqlError` (any other
rejection is classified for the driver's dialect), and so is no answer within `timeoutMs`,
a `ConnectionError` naming the timeout. A timed-out `select 1` is abandoned, not cancelled.
A `db` that is not a driver, or an option of the wrong type or range, is a `TypeError`,
thrown at the call.

- `db` (`Driver`)
- `options.timeoutMs` (`number`, optional): above 0, at most 2^31 − 1. Default `5_000`.

**Returns:** `Promise<HealthStatus>`

```ts
const status = await checkHealth(db, { timeoutMs: 2_000 });
if (!status.healthy) console.error(status.error);
```

#### `createHealthMonitor(db, options?)`

A monitor that runs `checkHealth` on `db` once started, and again `intervalMs` after each
check settled or timed out, so checks never overlap. Its timers never keep a process alive.

- `db` (`Driver`)
- `options.intervalMs` (`number`, optional): above 0, at most 2^31 − 1. Default `30_000`.
- `options.timeoutMs` (`number`, optional): per check, as in `checkHealth`. Default
  `5_000`.
- `options.onChange` (`(status, previous) => void`, optional): called with the first
  status (`previous` is `null`), then only when `healthy` flips. One that throws is
  caught, and the monitor goes on.

**Returns:** `HealthMonitor`

```ts
const monitor = createHealthMonitor(db, {
	onChange: (status) => log(status.healthy ? "db up" : "db down", status.error),
});
await monitor.start();
app.get("/health", () => monitor.last());
```

#### `HealthStatus`

```ts
interface HealthStatus {
	healthy: boolean;
	latencyMs: number | null; // null when it did not answer
	error: SqlError | null; // null when healthy
	checkedAt: Date; // when the check was sent
}
```

#### `HealthMonitor`

```ts
interface HealthMonitor {
	start(): Promise<void>;
	stop(): void;
	last(): HealthStatus | null;
}
```

- `start()` checks now, then every `intervalMs`. Resolves after the first check; never
  rejects. Called while the monitor runs, it answers that run's first check.
- `stop()` leaves no check scheduled; a check in progress is not reported. `start()`
  starts again.
- `last()` is the latest status, kept across `stop()`; `null` before the first check.

---

## `@marianmeres/sqlkit/sqlite`

The node:sqlite adapter, over a `DatabaseSync`: built into Node, nothing to install. One
handle is one connection, so it runs under the single-connection rule: every statement
takes its turn, and one from outside an open transaction waits for it. A transaction is
`BEGIN IMMEDIATE`, and a savepoint inside one is SQLite's `SAVEPOINT`. The driver has the
[sync tier](#syncdriver): `driver.sync` is the same handle, answering at once.

The driver can keep compiled statements, to run a query or a data change again when the
same text comes back. Over a database `openSqlite` opened it does; over a handle you
opened, when asked: see [`SqliteDriverOptions`](#sqlitedriveroptions).

### `openSqlite(path?, options?)`

Opens a database with the conventional settings and answers a driver over it: a busy
timeout and, for a file, the WAL journal, which lets readers on other connections read
while one writes.

- `path` (`string`, optional): default `":memory:"`.
- `options` (`OpenSqliteOptions`, optional)

**Returns:** `Driver`. A file that cannot be opened, or a journal that cannot be switched,
throws a `SqlError`; a path that is not a string is a `TypeError`, and so is an option out
of its range, before anything is opened.

```ts
import { openSqlite } from "@marianmeres/sqlkit/sqlite";

const db = openSqlite("app.db", { busyTimeout: 10_000 });
```

### `createSqliteDriver(db, options?)`

A driver over a database you opened. Nothing is set on the handle: its busy timeout,
journal mode and foreign keys are as you opened it. `close()` closes it. Anything that is
not a `DatabaseSync` is a `TypeError`. No compiled statement is kept unless
`options.statementCache` asks.

The driver knows the transactions opened through it, and no other. While one you opened
on the handle yourself is open (`db.exec("BEGIN")`), a statement through the driver runs
inside it, and `transaction()` and `savepoint()` are refused by SQLite, which will not
start a transaction within one.

- `db` (`DatabaseSync`, from `node:sqlite`)
- `options` (`SqliteDriverOptions`, optional)

**Returns:** `Driver`

```ts
import { DatabaseSync } from "node:sqlite";
import { createSqliteDriver } from "@marianmeres/sqlkit/sqlite";

const db = createSqliteDriver(new DatabaseSync("app.db", { timeout: 5_000 }));
```

### `SqliteDriverOptions`

```ts
interface SqliteDriverOptions {
	statementCache?: number; // openSqlite: 128; createSqliteDriver: 0, which keeps none
}
```

`statementCache` is how many compiled statements the driver keeps, by their text; a whole
number from 0. A query or a data change (a text that opens with `select`, `insert`,
`update`, `delete`, `replace`, `with` or `values`) is compiled on its first run and kept
to run again. A `sql` fragment renders to the same text whatever its values, so a
statement an app repeats is compiled once, on either tier. Past the number, the least
recently used one is dropped; a statement with a varying number of placeholders (`inList`,
an `insert` of several rows) is one text per number. With 0 every call compiles.

Any other text (a pragma, DDL) is compiled for each call, and it and every `exec` script
empty the cache: either may change what a kept statement means. One in a hot path costs
the statements kept around it.

A kept statement answers as a new one would after a schema change, on this connection or
another, and after a setting changed: SQLite recompiles it on its next run. What SQLite
reads only while compiling, a kept statement read once. Done on the handle after the
driver's first statement, these do not reach the statements already kept:

- an authorizer answering differently than it did (installing one does reach them);
- a session starting to record: a `delete` with no `where` kept before it is not in the
  changeset;
- a function or aggregate registered under a name already in use, with another number of
  arguments (replacing one of the same number does reach them);
- a virtual-table module replaced;
- a limit lowered.

None of it can be done to a database `openSqlite` opened, whose handle only the driver
has, so it keeps 128 statements by default. `createSqliteDriver` keeps none by default:
the handle is yours. Ask for a number there when you do none of the above.

Keeping statements is why the package needs Node 24.20+ or 26.6+: an earlier node:sqlite
misreads the columns of a statement SQLite recompiled after a schema change. `engines`
only warns, so the driver asks the runtime, once, and keeps nothing on a Node that
misreads, whatever the number.

### `OpenSqliteOptions`

```ts
interface OpenSqliteOptions extends SqliteDriverOptions {
	busyTimeout?: number; // default 5000; 0 fails at once
}
```

`busyTimeout` is the milliseconds a statement waits for another connection's lock on the
same file before it fails with a `BusyError`; a whole number from 0. The wait blocks the
thread: the handle is synchronous.

---

## `@marianmeres/sqlkit/pg`

The node-postgres adapter. Two factories, so that nothing is guessed from an object's
shape, and [`toPgDriver`](#topgdriverdb) for a library that is handed a pool, a client or
a driver and has to tell. Nothing is imported from `pg`: a `pg.Pool` or a `pg.Client` fits
the structural types below as it is.

On both, `query()` goes out on the extended protocol, so a text of several statements is
refused by the server before any of it runs; `exec()` is a simple query, any number of
statements. A read-only transaction is `REPEATABLE READ READ ONLY`. `COMMIT` is checked:
Postgres answers the `COMMIT` of an aborted transaction with `ROLLBACK`, which rejects with
a `TransactionAbortedError`. A savepoint is `SAVEPOINT`, then `RELEASE`, or `ROLLBACK TO`
when its callback rejected; a lock taken inside one that is rolled back to goes with it,
and one taken inside one that is kept is held to the transaction's end. `exclusive` is an
advisory lock keyed by the name and
`current_schema()`, polled, which every process on the database and schema honours, pool
and client drivers alike. The driver listens to the pool's or client's `error` event (an
idle connection dropped), and reports one through `process.emitWarning` only when the host
does not listen too.

### `createPgDriver(pool, options?)`

A driver over a pool you built. `transaction()` pins one connection for its length;
a statement from outside it runs on another connection at once. `exclusive()` pins one
connection too, and runs every statement of its callback on it, so a pool of one works
and `CREATE INDEX CONCURRENTLY` can run inside it. `close()` ends the pool.

- `pool` (`PgPoolLike`): a `pg.Pool`.
- `options` (`PgDriverOptions`, optional)

**Returns:** `Driver`, adapter `"pg"`.

```ts
import pg from "pg";
import { createPgDriver } from "@marianmeres/sqlkit/pg";

const db = createPgDriver(
	new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 }),
);
```

Set `connectionTimeoutMillis`: node-postgres's pool otherwise waits for a connection
without limit.

### `createPgClientDriver(client, options?)`

A driver over one client you connected: the same as the pool driver in every respect but
one, since a client is one session. A statement from outside an open transaction waits for
it to end, where a pool would run it on another connection. A `pg.Pool` is refused with a
`TypeError`. `close()` ends the client; a client whose connection failed stays failed, and
the host builds a new one.

- `client` (`PgStandaloneClientLike`): a connected `pg.Client`.
- `options` (`PgDriverOptions`, optional)

**Returns:** `Driver`, adapter `"pg-client"`.

```ts
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const db = createPgClientDriver(client, { schema: "app" });
```

### `toPgDriver(db)`

The `Driver` for whatever a library was handed as its database: the one function here
that reads an object's shape to decide what it is. An app knows what it holds and calls a
factory; a library whose `db` option takes any of the three calls this.

- `db` ([`PgDb`](#pgdb)): a `pg.Pool`, a connected `pg.Client`, or a `Driver` of the `pg`
  dialect.

**Returns:** `Driver`.

- **A `Driver`** comes back as it is: not wrapped, not kept. A PGlite driver is one of the
  `pg` dialect, and passes.
- **A pool or a client** gets the driver its factory builds, with no options: built on the
  first call, and the same one on every later call with that object. For a driver bound
  to a schema, build it with the factory and pass the `Driver`.

A pool is told by its count of connections (a numeric `totalCount`, as node-postgres's
has), or by having no `query()` of its own, which a client cannot lack. Anything else that
has a client's methods is taken for a client. A pool of another make, which has `query()`
and counts nothing, would be: pass it to `createPgDriver` yourself.

Anything else is a `TypeError`: a value that is none of the three, a `Driver` of another
dialect, and a `Driver` that lacks a member of the contract (one built by an older version
of this package), which the message names.

```ts
import { type PgDb, toPgDriver } from "@marianmeres/sqlkit/pg";

export function createQueue(options: { db: PgDb }) {
	const db = toPgDriver(options.db);
	// …everything else talks to `db`
}
```

**One driver per pool, and per client**, because a second one over the same object is not
harmless:

- Each driver listens to the pool's or client's `error` event and reports one only when
  nobody else listens. Two drivers take each other for the host's listener, and the error
  is reported by neither.
- One client is one session. Two drivers over it each give their own transactions their
  turn and know nothing of the other's: a statement sent through one lands inside the
  transaction the other has open, and goes with its rollback.

So every caller that converts the same pool or client shares one driver, and with it its
transactions: a statement issued inside a transaction's callback joins that transaction,
whoever converted. The driver is kept per copy of this package. An app whose libraries
resolve to two copies has one driver per copy: hand them one `Driver` instead of the pool
or the client.

Nothing is connected, sent or closed. `close()` on the driver ends the pool or the client,
as on any driver: a library that was handed its database does not call it.

### `PgDb`

```ts
type PgDb = PgPoolLike | PgStandaloneClientLike | Driver;
```

What `toPgDriver` takes, and the type for a library's own `db` option.

### `PgDriverOptions`

```ts
interface PgDriverOptions {
	schema?: string;
}
```

`schema` is set as the whole `search_path` of every connection the driver uses, once per
connection, before its first statement there: a table is created in, and found in,
exactly one place. Left unset, the connection's own `search_path` stands. It is set on the
connection, so whoever uses that connection afterwards sees it too.

### Structural types

Only what the adapter calls is declared.

| Type                     | Fits                                    | Members                                                                |
| ------------------------ | --------------------------------------- | ---------------------------------------------------------------------- |
| `PgPoolLike`             | a `pg.Pool`                             | `connect()`, `end()`, `on("error", …)`, `listenerCount("error")`       |
| `PgPoolClientLike`       | a `pg.PoolClient` the pool handed out   | `PgClientLike` and `release(destroy?)`                                 |
| `PgStandaloneClientLike` | a connected `pg.Client`                 | `PgClientLike` and `end()`, `on("error", …)`, `listenerCount("error")` |
| `PgClientLike`           | one session a statement runs on         | `query(config: PgQueryConfigLike): Promise<PgQueryResultLike>`         |
| `PgQueryConfigLike`      | one statement as node-postgres takes it | `text`, `values?`, `queryMode?: "extended"`                            |
| `PgQueryResultLike`      | the part of a result the adapter reads  | `rows`, `rowCount: number \| null`, `command`                          |

---

## `@marianmeres/sqlkit/pglite`

The PGlite adapter. PGlite is Postgres compiled to WebAssembly, running in your process:
Postgres semantics without a server, which makes it the in-memory database for tests of
code that runs on Postgres. Its dialect is `pg`. It is one connection, under the
single-connection rule, with no lock other processes honour. A savepoint is `SAVEPOINT`,
sent through the transaction PGlite handed out.

Values bind by the parameter rule, then by PGlite's serializers, chosen by the type the
server inferred for each placeholder: where it infers `text`, an array binds as `1,2` and
a `Date` as ISO text. Cast the placeholder (`cast(${list} as integer[])`) to bind as
node-postgres does. An `int8` reads as a number while it is a safe integer and as a
`bigint` beyond it, where node-postgres reads a string.

### `createPgliteDriver(db)`

A driver over a PGlite instance you created. `close()` closes the instance. A value that
lacks `query`, `exec`, `transaction` or `close` is a `TypeError`.

- `db` (`PgliteLike`)

**Returns:** `Driver`, adapter `"pglite"`.

```ts
import { PGlite } from "@electric-sql/pglite";
import { createPgliteDriver } from "@marianmeres/sqlkit/pglite";

const db = createPgliteDriver(await PGlite.create());
```

### `PgliteLike`, `PgliteTransactionLike`, `PgliteResultsLike`

```ts
interface PgliteResultsLike {
	rows: unknown[];
	affectedRows?: number;
	fields: readonly unknown[];
}
interface PgliteTransactionLike {
	query(query: string, params?: unknown[]): Promise<PgliteResultsLike>;
	exec(query: string): Promise<unknown>;
}
interface PgliteLike extends PgliteTransactionLike {
	transaction<T>(callback: (tx: PgliteTransactionLike) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}
```

The shapes the adapter takes: a `PGlite` instance fits `PgliteLike` as it is.

---

## `@marianmeres/sqlkit/do`

The Durable Objects adapter, over the SQLite storage of a Durable Object (`ctx.storage`).
Its dialect is `sqlite`. The storage is one connection, under the single-connection rule,
and its engine is synchronous, so the driver has the [sync tier](#syncdriver): `driver.sync`
is the same storage, answering at once. The async tier's transaction is
`storage.transaction`, the sync tier's `storage.transactionSync`, and a savepoint is the
same call made inside the open transaction, which workerd nests; no lock other objects
honour.

**It requires the `nodejs_compat` compatibility flag**: the driver carries a transaction
in `AsyncLocalStorage`, from `node:async_hooks`. Nothing is imported from workerd.

Where workerd makes it differ from node:sqlite:

| What                      | On Durable Objects                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An open async transaction | Holds the whole object: no other request reaches it until the transaction settles, even while it awaits a timer or a `fetch`. Do not await external I/O inside one.                                                                                                                                                                                                                                           |
| R11                       | Not enforced: `query()` with a text of several statements runs them all, since workerd has no way to refuse one before it runs. Pass one statement to `query()`, a script to `exec()`.                                                                                                                                                                                                                        |
| Transaction statements    | `BEGIN`, `SAVEPOINT`, `COMMIT` and `ROLLBACK` are refused by workerd, in a script too: a migration file cannot hold its own, and a savepoint cannot be written by hand. `transaction()` and `savepoint()` are the way.                                                                                                                                                                                        |
| `readOnly`                | Enforced by detection: a statement that wrote throws a `ReadOnlyError` (code `"8"`, as node:sqlite's), and the transaction throws it again once its callback returns, so the write rolls back even when the callback caught the first. A write refused inside a savepoint that is then undone went with the savepoint, and the transaction goes on. DDL that is not the last statement of a text goes unseen. |
| A deferred constraint     | Not checked when `transaction()` ends: workerd checks it when the request ends, and a violation resets the object to its last good state and fails the request. Keep foreign keys immediate.                                                                                                                                                                                                                  |
| `bigint` parameters       | Bound as the number they equal, since workerd binds no `bigint`; one outside the safe-integer range is a `TypeError`. Every number binds as a `real`; an `integer` column stores it as an integer.                                                                                                                                                                                                            |
| Rows                      | A blob reads back as a `Uint8Array` over the bytes workerd hands back as an `ArrayBuffer`. An integer reads back as a number, rounded beyond 2^53.                                                                                                                                                                                                                                                            |
| `close()`                 | Ends the driver: every call after it fails with a `SqlError`. The storage belongs to the object and stays as it is.                                                                                                                                                                                                                                                                                           |

### `createDoDriver(storage)`

A driver over a SQLite-backed Durable Object's storage. Anything without `sql.exec`,
`transaction` and `transactionSync` is a `TypeError`.

- `storage` (`DoStorageLike`): the object's `ctx.storage`.

**Returns:** `Driver`, adapter `"durable-objects"`, with `sync`.

```ts
import { DurableObject } from "cloudflare:workers";
import { createDoDriver } from "@marianmeres/sqlkit/do";

export class Room extends DurableObject {
	db = createDoDriver(this.ctx.storage);
}
```

### `DoStorageLike`, `DoSqlStorageLike`, `DoSqlCursorLike`

```ts
interface DoSqlCursorLike {
	toArray(): Record<string, unknown>[];
	readonly columnNames: readonly string[];
	readonly rowsWritten: number;
}
interface DoSqlStorageLike {
	exec(query: string, ...bindings: unknown[]): DoSqlCursorLike;
}
interface DoStorageLike {
	readonly sql: DoSqlStorageLike;
	transactionSync<T>(closure: () => T): T;
	transaction<T>(closure: () => Promise<T>): Promise<T>;
}
```

The shapes the adapter takes: a Durable Object's `ctx.storage` fits `DoStorageLike` as it
is.

---

## `@marianmeres/sqlkit/migrate`

[`@marianmeres/migrate`](https://www.npmjs.com/package/@marianmeres/migrate) wired over a
`Driver`: one set of versions runs on every adapter, inside the driver's own transactions,
savepoints and locks. Runtime-neutral.

### `createMigrate(db, options?)`

A `Migrate` instance that keeps its active version in a table of `db`'s database and runs
every version through `db`. Register versions with `addVersion(version, up, down?)` (or
[`addSqlFiles`](#addsqlfilesmigrate-dir)), then `up()`, `down()`, `status()`: the
migrate package's own API.

| Hook               | `capabilities.crossProcessLock` true (`pg`, `pg-client`)          | otherwise (`node:sqlite`, `pglite`, `durable-objects`)    |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `wrapRun`          | `db.exclusive("migrate:<table>", run)`                            | `db.transaction(run)`                                     |
| `wrapStep`         | `db.savepoint(run)`: a transaction per step, committed as it ends | `db.savepoint(run)`: a savepoint of the run's transaction |
| `getActiveVersion` | the newest row; `null` while no table exists                      | same                                                      |
| `setActiveVersion` | one insert, under the run lock                                    | same                                                      |

A failed step is undone alone, with its version mark, and the steps before it stay, on
every adapter. Where the lock crosses processes each step is a transaction of its own.
Elsewhere the run is one transaction and each step a savepoint of it: when a step fails,
the transaction is committed with what the steps before it did, and the run rejects with
the step's failure. (Up to 0.2.0 a failed step undid the whole run there.) Only a step
whose savepoint the database would not roll back to takes the whole run with it. The
version table's DDL and the lock name are the migrate package's own helpers', so either
can continue a database the other migrated, and the two exclude each other while running.

A worker receives `{ ...context, db }`: what it issues through `db` runs inside the step,
and is undone with it. It must not send `BEGIN`, `COMMIT` or `ROLLBACK` itself, and cannot
run a statement that refuses a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`).

One active version is stored, not a ledger of applied steps: a version registered later
below the active one is never applied, and never reported as pending.

- `db` (`Driver`): the caller keeps owning it, and closes it.
- `options` (`MigrateOptions`, optional)

**Returns:** `Migrate<TExtra & MigrateContext>`. A `db` that is not a driver, or an option
that is not what it says, is a `TypeError`.

```ts
import { createMigrate } from "@marianmeres/sqlkit/migrate";

const migrate = createMigrate(db, { context: { log } });
migrate.addVersion(
	"1.0.0",
	({ db }) => db.exec("create table job (id integer primary key, tenant text)"),
	({ db }) => db.exec("drop table job"),
);
await migrate.up();
```

### `MigrateOptions`

```ts
interface MigrateOptions<TExtra extends Record<string, unknown> = Record<never, never>> {
	table?: string; // default MIGRATE_TABLE
	context?: TExtra;
	logger?: (...args: unknown[]) => void;
}
```

- `table`: the table the active version is kept in, created by the first run. Letters,
  digits and underscores, not starting with a digit.
- `context`: extra properties for the context every worker receives, next to `db`. `db`
  wins over an extra key of that name.
- `logger`: handed to `Migrate` as it is.

### `MigrateContext`

```ts
interface MigrateContext {
	db: Driver;
}
```

The context every worker receives, next to the extra properties of `options.context`.

### `MIGRATE_TABLE`

`"__migrate__"`: the default name of the version table, the migrate package's own helpers'
default too.

---

## `@marianmeres/sqlkit/migrate/files`

SQL files as versions. **Node only** (it reads the file system), and a separate entry
point for that reason.

### `addSqlFiles(migrate, dir)`

Registers on `migrate` every version found in `dir`, its workers running each file's text
through the driver's `exec`.

- `migrate` (`Migrate<TContext extends MigrateContext>`): typically from `createMigrate`.
- `dir` (`string`): the directory; subdirectories are not read.

**Returns:** `Promise<string[]>`: the versions registered, normalized, in semver order.

- **Names.** `<version>.up.sql`, optionally `<version>.down.sql`, optionally labelled:
  `<version>__<label>.up.sql`. The version is anything semver accepts (`1`, `1.2`,
  `v1.2.3`, `2.0.0-rc.1`), normalized. The label, the text after the first `__`, is the
  version's comment. An up and a down file pair by version, not by label. A version with no
  down file is irreversible: `down()` refuses a path that crosses it.
- **Each file is one `exec`**, so it may hold several statements. It runs inside the
  step's transaction. Files are read when the version is registered, a leading byte-order
  mark dropped; a file changed afterwards is not read again.
- **Refusals**, all before anything is registered, each a `TypeError` (a rejection) naming
  the file: a `.sql` file (in any case) that does not match the pattern, an empty label, a
  version semver rejects, a down file with no up file, two files for one version and
  direction (`1.up.sql` and `1.0.0.up.sql` are one version), a version the instance already
  has, and a directory with no version. A missing directory rejects with the file system's
  own error. Any other file is ignored.

```ts
import { createMigrate } from "@marianmeres/sqlkit/migrate";
import { addSqlFiles } from "@marianmeres/sqlkit/migrate/files";

// migrations/1.0.0__init.up.sql, 1.0.0.down.sql, 1.1.0__add_status.up.sql
const migrate = createMigrate(db);
await addSqlFiles(migrate, "./migrations");
await migrate.up();
```
