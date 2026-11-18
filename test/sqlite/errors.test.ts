// Typed errors the node:sqlite adapter alone produces (plan doc 01 #4): a busy database, met
// by a write, by the `BEGIN IMMEDIATE` of a transaction and on the sync tier, and a file
// that cannot be opened.
//
// Adapter-specific: being busy takes a second handle on the same file, and opening a file
// is `openSqlite`'s. The errors every adapter produces are in the `errors` conformance
// body. The second handle waits 0 ms, so the refusal is immediate rather than timed.
//
// Suite names start with `sqlite/`: `pnpm run test:sqlite` selects them by it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BusyError, SqlError } from "../../src/mod.ts";
import { openSqlite } from "../../src/sqlite/mod.ts";

/** A temporary directory for database files, removed after `fn`. */
async function inTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "sqlkit-sqlite-errors-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** What `promise` rejected with; a fulfilment fails the case. */
async function rejection(what: string, promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail(`${what} was not refused`),
		(error: unknown) => error,
	);
}

/** What `call` threw; a return fails the case. */
function thrown(what: string, call: () => unknown): unknown {
	try {
		call();
	} catch (error) {
		return error;
	}
	return assert.fail(`${what} was not refused`);
}

/** `error` is SQLite's `SQLITE_BUSY`, typed, with node:sqlite's error as `cause`. */
function assertBusy(what: string, error: unknown): void {
	assert.ok(error instanceof BusyError, `${what}: ${String(error)}`);
	assert.equal(error.kind, "busy");
	assert.equal(error.dialect, "sqlite");
	assert.equal(error.code, "5");
	assert.equal(error.retryable, true);
	assert.equal(error.message, "database is locked");
	const cause = error.cause as { errcode?: unknown } | undefined;
	assert.ok(cause instanceof Error && !(cause instanceof SqlError), what);
	assert.equal(cause.errcode, 5);
}

describe("sqlite/errors", () => {
	test("a busy database is a BusyError, retryable: from a write, a BEGIN and the sync tier", async () => {
		await inTempDir(async (dir) => {
			const path = join(dir, "busy.db");
			const holder = openSqlite(path);
			const waiter = openSqlite(path, { busyTimeout: 0 });
			try {
				await holder.exec("create table t (id text primary key)");
				await holder.transaction(async (tx) => {
					await tx.query("insert into t (id) values ('held')");
					assertBusy(
						"a write",
						await rejection(
							"a write",
							waiter.query("insert into t (id) values ('w')"),
						),
					);
					// The transaction's own BEGIN IMMEDIATE is refused, before the callback.
					assertBusy(
						"a transaction",
						await rejection(
							"a transaction",
							waiter.transaction(async () =>
								assert.fail("the callback ran"),
							),
						),
					);
					const sync = waiter.sync;
					assert.ok(sync !== undefined);
					assertBusy(
						"a sync write",
						thrown("a sync write", () =>
							sync.query("insert into t (id) values ('w')"),
						),
					);
					assertBusy(
						"a sync transaction",
						thrown("a sync transaction", () =>
							sync.transaction(() => assert.fail("the callback ran")),
						),
					);
				});
				// Free again, the same work goes through.
				await waiter.transaction(async (tx) => {
					await tx.query("insert into t (id) values ('w')");
				});
				const { rows } = await holder.query("select id from t order by id");
				assert.deepEqual(rows, [{ id: "held" }, { id: "w" }]);
			} finally {
				await holder.close();
				await waiter.close();
			}
		});
	});

	test("a file that cannot be opened is a SqlError from openSqlite; a bad path a TypeError", async () => {
		await inTempDir(async (dir) => {
			const error = thrown("a file in a missing directory", () =>
				openSqlite(join(dir, "missing", "x.db")),
			);
			assert.ok(error instanceof SqlError, String(error));
			// SQLITE_CANTOPEN has no kind of its own.
			assert.equal(error.kind, "unknown");
			assert.equal(error.dialect, "sqlite");
			assert.equal(error.code, "14");
			const cause = error.cause as { errcode?: unknown } | undefined;
			assert.ok(cause instanceof Error && !(cause instanceof SqlError));
			assert.equal(cause.errcode, 14);
			assert.equal(error.message, cause.message);

			const mistake = thrown("a number as the path", () =>
				openSqlite(42 as unknown as string),
			);
			assert.ok(mistake instanceof TypeError, String(mistake));
			assert.ok(!(mistake instanceof SqlError));
		});
	});
});
