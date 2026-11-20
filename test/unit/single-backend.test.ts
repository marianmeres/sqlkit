// The single-connection core against a stub backend (plan doc 02 #2): the parts of the
// seam no registered adapter exercises yet. node:sqlite and the `pg.Client` backend hand
// their transaction callback themselves, and only the client has a lock other processes
// honour; a backend whose library hands out a transaction object arrives with a later
// adapter. The routing and the lock calls are the core's, so they are pinned here, on a
// backend that records what it was asked. No database.
//
// The sync tier's routing is pinned here too (plan doc 02 #3), along with the one moment
// of S4 no adapter can be timed into: after the async callback settled, before the
// backend committed.
//
// And the savepoint (backlog T26): when the backend is asked for one, under which name, in
// which order with what the enclosing scope issued, and what the core does when the
// savepoint's own statements are refused, which no real database can be made to do.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	BusyError,
	type DialectName,
	SqlError,
	type SqlErrorInfo,
	TransactionAbortedError,
} from "../../src/mod.ts";
import type {
	Connection,
	SingleConnectionBackend,
	SyncBackend,
} from "../../src/single/backend.ts";
import { createSingleConnectionDriver } from "../../src/single/driver.ts";

/** A gate a case opens by hand. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

interface Stub {
	backend: SingleConnectionBackend;
	log: string[];
}

/**
 * An asynchronous backend that logs every call. Its transaction hands the callback a
 * connection of its own (`tx`), as a library with transaction objects does.
 */
function stub(options: { lock?: boolean; failRelease?: boolean } = {}): Stub {
	const log: string[] = [];
	const connection = (tag: string): Connection => ({
		async run(text, params) {
			log.push(
				`${tag}: ${text}${params.length > 0 ? ` ${JSON.stringify(params)}` : ""}`,
			);
			return { rows: [], rowCount: 0 };
		},
		async exec(script) {
			log.push(`${tag} exec: ${script}`);
		},
	});
	const own = connection("backend");
	const backend: SingleConnectionBackend = {
		dialect: "pg",
		adapter: "stub",
		run: own.run,
		exec: own.exec,
		async transaction(fn, readOnly) {
			log.push(readOnly ? "begin read only" : "begin");
			try {
				const result = await fn(connection("tx"));
				log.push("commit");
				return result;
			} catch (error) {
				log.push("rollback");
				throw error;
			}
		},
		async savepoint(fn, inner, name) {
			await inner.exec(`savepoint ${name}`);
			let result: Awaited<ReturnType<typeof fn>>;
			try {
				result = await fn();
			} catch (error) {
				await inner.exec(`rollback to ${name}`);
				throw error;
			}
			await inner.exec(`release ${name}`);
			return result;
		},
		classify: () => ({ kind: "unknown" }),
		async close() {
			log.push("close");
		},
	};
	if (options.lock) {
		backend.lock = async (name, inTransaction) => {
			log.push(`lock ${name}${inTransaction ? " in transaction" : ""}`);
			return async () => {
				log.push(`unlock ${name}`);
				if (options.failRelease) throw new Error("unlock failed");
			};
		};
	}
	return { backend, log };
}

describe("unit/single-backend: routing", () => {
	test("the driver carries the backend's dialect and name; crossProcessLock follows lock", () => {
		const plain = createSingleConnectionDriver(stub().backend);
		assert.equal(plain.dialect, "pg");
		assert.equal(plain.adapter, "stub");
		assert.deepEqual(plain.capabilities, {
			sync: false,
			concurrentWriters: false,
			crossProcessLock: false,
		});
		const locking = createSingleConnectionDriver(stub({ lock: true }).backend);
		assert.equal(locking.capabilities.crossProcessLock, true);
	});

	test("inside a transaction statements go through the connection it was handed", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend);
		const settled = gate();
		let straggler: Promise<unknown> | undefined;
		await db.query("select $1", [true]);
		await db.transaction(
			async (tx) => {
				await tx.query("insert 1");
				await tx.exec("script 1");
				await tx.transaction(async (nested) => nested.query("nested 1"));
				straggler = (async () => {
					await settled.opened;
					await db.query("late 1");
				})();
			},
			{ readOnly: true },
		);
		settled.open();
		await straggler;
		await db.exec("script 2");
		assert.deepEqual(log, [
			"backend: select $1 [true]",
			"begin read only",
			"tx: insert 1",
			"tx exec: script 1",
			"tx: nested 1",
			"commit",
			"backend: late 1",
			"backend exec: script 2",
		]);
	});

	test("parameters reach the backend bound by the rule, as a copy", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend);
		const params = [undefined, { a: 1 }];
		await db.query("select $1, $2", params);
		assert.deepEqual(params, [undefined, { a: 1 }], "the caller's array changed");
		assert.deepEqual(log, ['backend: select $1, $2 [null,"{\\"a\\":1}"]']);
	});

	test("close() runs after the work queued before it, once", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend);
		const work = db.query("queued");
		const first = db.close();
		assert.equal(db.close(), first);
		await Promise.all([work, first]);
		assert.deepEqual(log, ["backend: queued", "close"]);
	});
});

describe("unit/single-backend: exclusive over a backend lock", () => {
	test("outside a transaction the lock is taken in the connection's turn, and released", async () => {
		const { backend, log } = stub({ lock: true });
		const db = createSingleConnectionDriver(backend);
		const release = gate();
		const open = db.transaction(async (tx) => {
			await tx.query("in transaction");
			await release.opened;
		});
		// While the transaction is open, the lock's statement waits for it like any other.
		const locked = db.exclusive("job", async (tx) => {
			await tx.query("under lock");
			// Re-entrant: the lock is not taken twice.
			await tx.exclusive("job", async (inner) => inner.query("re-entered"));
			return "done";
		});
		await sleep(20);
		assert.deepEqual(log, ["begin", "tx: in transaction"]);
		release.open();
		assert.equal(await locked, "done");
		await open;
		assert.deepEqual(log, [
			"begin",
			"tx: in transaction",
			"commit",
			"lock job",
			"backend: under lock",
			"backend: re-entered",
			"unlock job",
		]);
	});

	test("a second caller of one name takes the lock after the first released it", async () => {
		const { backend, log } = stub({ lock: true });
		const db = createSingleConnectionDriver(backend);
		const first = gate();
		const a = db.exclusive("job", async () => {
			await first.opened;
		});
		const b = db.exclusive("job", async (tx) => tx.query("second"));
		await sleep(20);
		assert.deepEqual(log, ["lock job"]);
		first.open();
		await Promise.all([a, b]);
		assert.deepEqual(log, [
			"lock job",
			"unlock job",
			"lock job",
			"backend: second",
			"unlock job",
		]);
	});

	test("inside a transaction the lock is taken on it, once", async () => {
		const { backend, log } = stub({ lock: true });
		const db = createSingleConnectionDriver(backend);
		await db.transaction(async (tx) => {
			await tx.exclusive("job", async (inner) => {
				await inner.query("under lock");
				await inner.exclusive("job", async () => undefined);
			});
		});
		assert.deepEqual(log, [
			"begin",
			"lock job in transaction",
			"tx: under lock",
			"unlock job",
			"commit",
		]);
	});

	test("fn's rejection wins over a failed release; a failed release alone rejects", async () => {
		const { backend } = stub({ lock: true, failRelease: true });
		const db = createSingleConnectionDriver(backend);
		const failed = new Error("fn failed");
		await assert.rejects(
			db.exclusive("job", async () => {
				throw failed;
			}),
			(error) => error === failed,
		);
		await assert.rejects(
			db.exclusive("job", async () => "fine"),
			/unlock failed/,
		);
		// The name is free again either way: the next caller runs.
		let ran = false;
		await assert.rejects(
			db.exclusive("job", async () => {
				ran = true;
			}),
			/unlock failed/,
		);
		assert.ok(ran, "the name stayed taken after a failed release");
	});
});

/** A sync backend that logs into `log`, as the stub's own connection would. */
function syncStub(log: string[]): SyncBackend {
	return {
		run(text, params) {
			log.push(
				`sync: ${text}${params.length > 0 ? ` ${JSON.stringify(params)}` : ""}`,
			);
			return { rows: [], rowCount: 0 };
		},
		exec(script) {
			log.push(`sync exec: ${script}`);
		},
		transaction(fn, readOnly) {
			log.push(readOnly ? "sync begin read only" : "sync begin");
			try {
				const result = fn();
				log.push("sync commit");
				return result;
			} catch (error) {
				log.push("sync rollback");
				throw error;
			}
		},
		savepoint(fn, name) {
			log.push(`sync savepoint ${name}`);
			try {
				const result = fn();
				log.push(`sync release ${name}`);
				return result;
			} catch (error) {
				log.push(`sync rollback to ${name}`);
				throw error;
			}
		},
	};
}

describe("unit/single-backend: the sync tier", () => {
	test("a sync backend makes the tier: capabilities.sync, and sync on the driver itself", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend, syncStub(log));
		assert.equal(db.capabilities.sync, true);
		assert.ok(db.sync !== undefined);
		assert.equal(db.sync.capabilities, db.capabilities);
		await db.transaction(async (tx) => {
			assert.equal(
				tx,
				db,
				"the callback was handed a driver without its sync tier",
			);
			assert.equal(tx.sync, db.sync);
		});
		const without = createSingleConnectionDriver(stub().backend);
		assert.equal("sync" in without, false);
	});

	test("the backend is asked for a sync transaction only at the top level", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend, syncStub(log));
		const sync = db.sync;
		assert.ok(sync !== undefined);
		sync.transaction(
			(tx) => {
				tx.query("select ?", [true]);
				tx.transaction((nested) => nested.exec("nested"));
			},
			{ readOnly: true },
		);
		// Inside an async transaction's own context: its connection, no transaction of
		// the sync backend's.
		await db.transaction(async () => {
			sync.query("joined");
			sync.transaction((tx) => tx.query("joined transaction"));
		});
		assert.deepEqual(log, [
			"sync begin read only",
			"sync: select ? [true]",
			"sync exec: nested",
			"sync commit",
			"begin",
			"sync: joined",
			"sync: joined transaction",
			"commit",
		]);
	});

	test("S4 holds until the backend has committed, not only until the callback settled", async () => {
		const { backend, log } = stub();
		const settled = gate();
		const committing = gate();
		// A backend that, like a real one, still has work to do after the callback.
		backend.transaction = async (fn) => {
			log.push("begin");
			const result = await fn(backend);
			settled.open();
			await committing.opened;
			log.push("commit");
			return result;
		};
		const db = createSingleConnectionDriver(backend, syncStub(log));
		const sync = db.sync;
		assert.ok(sync !== undefined);
		let straggler: Promise<unknown> | undefined;
		const open = db.transaction(async () => {
			// Started inside, run after the callback settled: a stranger by then (R6).
			straggler = (async () => {
				await settled.opened;
				return sync.query("straggler");
			})();
		});
		await settled.opened;
		try {
			assert.throws(() => sync.query("stranger"), TypeError);
			await assert.rejects(straggler ?? Promise.resolve(), TypeError);
		} finally {
			committing.open();
		}
		await open;
		sync.query("after");
		assert.deepEqual(log, ["begin", "commit", "sync: after"]);
	});
});

// ── typed errors (plan doc 01 #4) ───────────────────────────────────────────────────
//
// The core wraps what the backend throws, wherever it throws it. node:sqlite reaches the
// statement, the script and a transaction's BEGIN and COMMIT, on both tiers (the `errors`
// conformance body); no registered adapter yet has a lock whose taking or release can
// fail, or a backend refusal of its own that is a `TypeError`. A backend that fails at a
// chosen point pins those, and the classifier the core must use is the backend's.

/** A driver's error, as the stub throws it: its classifier reads it as `busy`. */
function driverError(where: string): Error {
	return Object.assign(new Error(`driver failed at ${where}`), { stubBusy: true });
}

/** The stub's classifier: the core must ask the backend's, not pick one by dialect. */
function classifyStub(error: unknown): SqlErrorInfo {
	return (error as { stubBusy?: unknown } | null)?.stubBusy === true
		? { kind: "busy", code: "STUB" }
		: { kind: "unknown" };
}

/** Both tiers of a backend that throws a driver's error at `failAt`, and nowhere else. */
function failing(failAt: string): SingleConnectionBackend & { sync: SyncBackend } {
	const fail = (where: string): void => {
		if (where === failAt) throw driverError(where);
	};
	const connection: Connection = {
		async run() {
			fail("run");
			if (failAt === "refusal") throw new TypeError("the backend's own refusal");
			return { rows: [], rowCount: 0 };
		},
		async exec() {
			fail("exec");
		},
	};
	return {
		dialect: "sqlite",
		adapter: "stub",
		run: connection.run,
		exec: connection.exec,
		async transaction(fn) {
			fail("begin");
			const result = await fn(connection);
			fail("commit");
			return result;
		},
		async savepoint(fn) {
			fail("savepoint");
			let result: Awaited<ReturnType<typeof fn>>;
			try {
				result = await fn();
			} catch (error) {
				fail("undo");
				throw error;
			}
			fail("keep");
			return result;
		},
		async lock() {
			fail("lock");
			return async () => {
				fail("release");
			};
		},
		classify: classifyStub,
		async close() {
			fail("close");
		},
		sync: {
			run() {
				fail("sync run");
				return { rows: [], rowCount: 0 };
			},
			exec() {
				fail("sync exec");
			},
			transaction(fn) {
				fail("sync begin");
				const result = fn();
				fail("sync commit");
				return result;
			},
			savepoint(fn) {
				fail("sync savepoint");
				let result: ReturnType<typeof fn>;
				try {
					result = fn();
				} catch (error) {
					fail("sync undo");
					throw error;
				}
				fail("sync keep");
				return result;
			},
		},
	};
}

/** `error` is the stub's driver error from `where`, wrapped by the backend's classifier. */
function assertWrapped(error: unknown, where: string): void {
	assert.ok(error instanceof BusyError, `${where}: ${String(error)}`);
	assert.equal(error.dialect, "sqlite");
	assert.equal(error.code, "STUB");
	assert.equal(error.message, `driver failed at ${where}`);
	assert.equal((error.cause as Error).message, `driver failed at ${where}`);
	assert.ok(!(error.cause instanceof SqlError));
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

describe("unit/single-backend: typed errors", () => {
	test("whatever the backend throws, wherever, is wrapped by the backend's classifier", async () => {
		const cases: [
			string,
			(db: ReturnType<typeof createSingleConnectionDriver>) => Promise<unknown>,
		][] = [
			["run", (db) => db.query("x")],
			["run", (db) => db.transaction((tx) => tx.query("x"))],
			["exec", (db) => db.exec("x")],
			[
				"begin",
				(db) => db.transaction(async () => assert.fail("the callback ran")),
			],
			["commit", (db) => db.transaction(async () => "done")],
			[
				"lock",
				(db) => db.exclusive("job", async () => assert.fail("the callback ran")),
			],
			[
				"lock",
				(db) => db.transaction((tx) => tx.exclusive("job", async () => "done")),
			],
			["release", (db) => db.exclusive("job", async () => "done")],
			[
				"savepoint",
				(db) =>
					db.transaction((tx) =>
						tx.savepoint(async () => assert.fail("the callback ran")),
					),
			],
			["keep", (db) => db.transaction((tx) => tx.savepoint(async () => "done"))],
			[
				// The rollback's refusal, not the callback's own error: the unit is still
				// in the transaction, and the caller has to learn that.
				"undo",
				(db) =>
					db.transaction((tx) =>
						tx.savepoint(async () => {
							throw new Error("the callback's own");
						}),
					),
			],
			["close", (db) => db.close()],
		];
		for (const [where, call] of cases) {
			const backend = failing(where);
			const db = createSingleConnectionDriver(backend, backend.sync);
			assertWrapped(await rejection(where, call(db)), where);
		}
	});

	test("the sync tier wraps the same way, and throws at the call", () => {
		const cases: [
			string,
			(
				sync: NonNullable<
					ReturnType<typeof createSingleConnectionDriver>["sync"]
				>,
			) => unknown,
		][] = [
			["sync run", (sync) => sync.query("x")],
			["sync run", (sync) => sync.transaction((tx) => tx.query("x"))],
			["sync exec", (sync) => sync.exec("x")],
			[
				"sync begin",
				(sync) => sync.transaction(() => assert.fail("the callback ran")),
			],
			["sync commit", (sync) => sync.transaction(() => "done")],
			[
				"sync savepoint",
				(sync) =>
					sync.transaction((tx) =>
						tx.savepoint(() => assert.fail("the callback ran")),
					),
			],
			["sync keep", (sync) => sync.transaction((tx) => tx.savepoint(() => "done"))],
			[
				"sync undo",
				(sync) =>
					sync.transaction((tx) =>
						tx.savepoint(() => {
							throw new Error("the callback's own");
						}),
					),
			],
		];
		for (const [where, call] of cases) {
			const backend = failing(where);
			const sync = createSingleConnectionDriver(backend, backend.sync).sync;
			assert.ok(sync !== undefined);
			assertWrapped(
				thrown(where, () => call(sync)),
				where,
			);
		}
	});

	test("a backend's TypeError and a callback's error, even a driver's, come out as thrown", async () => {
		const refusing = failing("refusal");
		const refused = await rejection(
			"a refusal",
			createSingleConnectionDriver(refusing).query("x"),
		);
		assert.ok(refused instanceof TypeError && !(refused instanceof SqlError));
		assert.equal(refused.message, "the backend's own refusal");

		const backend = failing("nowhere");
		const db = createSingleConnectionDriver(backend, backend.sync);
		const sync = db.sync;
		assert.ok(sync !== undefined);
		// Shaped so that the backend's classifier would read it as `busy`.
		const own = driverError("the callback");
		for (const [what, call] of [
			["transaction", () => db.transaction(async () => Promise.reject(own))],
			["exclusive", () => db.exclusive("job", async () => Promise.reject(own))],
			[
				"exclusive inside a transaction",
				() =>
					db.transaction((tx) =>
						tx.exclusive("job", async () => Promise.reject(own)),
					),
			],
		] as const) {
			assert.equal(await rejection(what, call()), own, what);
		}
		assert.equal(
			thrown("sync.transaction", () =>
				sync.transaction(() => {
					throw own;
				}),
			),
			own,
		);
	});
});

// ── an aborted transaction (plan doc 02 #5) ─────────────────────────────────────────
//
// On `pg` the core refuses to commit a transaction a failed statement aborted. The client
// driver's suite (test/pg/client.test.ts) shows it against Postgres: no COMMIT sent, a
// statement the callback did not await waited for, a savepoint's recovery. What no real
// failure reaches is pinned here: a backend's own `TypeError` is no failure, a lock's
// failure is one, a lock's success recovers nothing, and SQLite is left alone.

/**
 * A backend of `dialect` that logs its transaction's end, and whose statements, lock and
 * release fail as their text or name says: `fail…` with a driver's error, `refuse…` with
 * a `TypeError` of the backend's own.
 */
function aborting(
	dialect: DialectName,
	steps: { open?: string; release?: string; undo?: string; only?: string } = {},
): Stub {
	const log: string[] = [];
	/** What a savepoint's own statement does: as `steps` says, for the savepoint it names. */
	const step = (name: string, what: string | undefined): void => {
		if (steps.only === undefined || steps.only === name) outcome(what ?? "");
	};
	const outcome = (what: string): void => {
		if (what.startsWith("fail")) throw driverError(what);
		if (what.startsWith("refuse")) throw new TypeError(`refused ${what}`);
	};
	const backend: SingleConnectionBackend = {
		dialect,
		adapter: "stub",
		async run(text) {
			outcome(text);
			return { rows: [], rowCount: 0 };
		},
		async exec(script) {
			outcome(script);
		},
		async transaction(fn) {
			try {
				const result = await fn(backend);
				log.push("commit");
				return result;
			} catch (error) {
				log.push("rollback");
				throw error;
			}
		},
		async savepoint(fn, _inner, name) {
			// The savepoint's own statements fail as the options say.
			step(name, steps.open);
			let result: Awaited<ReturnType<typeof fn>>;
			try {
				result = await fn();
			} catch (error) {
				step(name, steps.undo);
				log.push(`rollback to ${name}`);
				throw error;
			}
			step(name, steps.release);
			log.push(`release ${name}`);
			return result;
		},
		async lock(name) {
			outcome(name);
			return async () => {
				outcome(`${name} release`);
			};
		},
		classify: classifyStub,
		async close() {},
	};
	return { backend, log };
}

describe("unit/single-backend: an aborted transaction", () => {
	test("pg: a swallowed failure rolls back with TransactionAbortedError, the failure its cause", async () => {
		const { backend, log } = aborting("pg");
		const db = createSingleConnectionDriver(backend);
		let failed: unknown;
		const error = await rejection(
			"the transaction",
			db.transaction(async (tx) => {
				failed = await rejection("exec", tx.exec("fail script"));
				return "swallowed";
			}),
		);
		assert.ok(error instanceof TransactionAbortedError, String(error));
		assert.equal(error.dialect, "pg");
		assert.equal(error.kind, "aborted");
		assert.ok(failed instanceof BusyError);
		assert.equal(error.cause, failed);
		assert.deepEqual(log, ["rollback"]);
		// The next transaction starts with nothing counted against it.
		assert.equal(await db.transaction(async () => "next"), "next");
		assert.deepEqual(log, ["rollback", "commit"]);
	});

	test("pg: the first failure is the cause; a later statement's success clears it", async () => {
		const { backend, log } = aborting("pg");
		const db = createSingleConnectionDriver(backend);
		let first: unknown;
		const error = await rejection(
			"the transaction",
			db.transaction(async (tx) => {
				first = await rejection("first", tx.query("fail 1"));
				await rejection("second", tx.query("fail 2"));
			}),
		);
		assert.equal((error as Error).cause, first);
		assert.equal(
			await db.transaction(async (tx) => {
				await rejection("a failure", tx.query("fail"));
				await tx.query("rollback to savepoint");
				return "recovered";
			}),
			"recovered",
		);
		assert.deepEqual(log, ["rollback", "commit"]);
	});

	test("pg: a backend's TypeError is no failure; the callback's own error still wins", async () => {
		const { backend, log } = aborting("pg");
		const db = createSingleConnectionDriver(backend);
		assert.equal(
			await db.transaction(async (tx) => {
				await assert.rejects(tx.query("refuse"), TypeError);
				return "committed";
			}),
			"committed",
		);
		const own = new Error("the callback's own");
		assert.equal(
			await rejection(
				"the transaction",
				db.transaction(async (tx) => {
					await rejection("a failure", tx.query("fail"));
					throw own;
				}),
			),
			own,
		);
		assert.deepEqual(log, ["commit", "rollback"]);
	});

	test("pg: a failed lock inside the transaction aborts it; a lock's success recovers nothing", async () => {
		const { backend, log } = aborting("pg");
		const db = createSingleConnectionDriver(backend);
		await assert.rejects(
			db.transaction(async (tx) => {
				await rejection(
					"the lock",
					tx.exclusive("fail lock", async () => undefined),
				);
			}),
			TransactionAbortedError,
		);
		await assert.rejects(
			db.transaction(async (tx) => {
				await rejection("a failure", tx.query("fail"));
				// Taken and released, neither by a statement the server ran.
				await tx.exclusive("job", async () => undefined);
			}),
			TransactionAbortedError,
		);
		assert.deepEqual(log, ["rollback", "rollback"]);
	});

	test("sqlite: a swallowed failure commits the rest, as SQLite does", async () => {
		const { backend, log } = aborting("sqlite");
		const db = createSingleConnectionDriver(backend);
		assert.equal(
			await db.transaction(async (tx) => {
				await rejection("a failure", tx.query("fail"));
				return "committed";
			}),
			"committed",
		);
		assert.deepEqual(log, ["commit"]);
	});
});

describe("unit/single-backend: savepoints", () => {
	test("the backend is asked for one inside a transaction only, on its connection, named by depth", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend);
		const boom = new Error("boom");
		// Outside a transaction it is a transaction: no savepoint is asked for.
		await db.savepoint((tx) => tx.query("top"));
		await db.transaction(async (tx) => {
			await tx.savepoint(async (sp) => {
				await sp.query("first");
				const inner = sp.savepoint(async (nested) => {
					await nested.query("second");
					throw boom;
				});
				assert.equal(await rejection("the inner savepoint", inner), boom);
			});
			await tx.savepoint((sp) => sp.query("sibling"));
		});
		assert.deepEqual(log, [
			"begin",
			"tx: top",
			"commit",
			"begin",
			"tx exec: savepoint sqlkit_1",
			"tx: first",
			"tx exec: savepoint sqlkit_2",
			"tx: second",
			"tx exec: rollback to sqlkit_2",
			"tx exec: release sqlkit_1",
			"tx exec: savepoint sqlkit_1",
			"tx: sibling",
			"tx exec: release sqlkit_1",
			"commit",
		]);
	});

	test("what the enclosing scope issues while one runs is sent after it, in the order issued", async () => {
		const { backend, log } = stub({ lock: true });
		const db = createSingleConnectionDriver(backend);
		const inside = gate();
		const proceed = gate();
		await db.transaction(async (tx) => {
			const first = tx.savepoint(async (sp) => {
				await sp.query("inside 1");
				inside.open();
				await proceed.opened;
				await sp.query("inside 2");
			});
			await inside.opened;
			const waiting = [
				tx.query("outside 1"),
				tx.exec("outside 2"),
				tx.savepoint((sp) => sp.query("second savepoint")),
				tx.exclusive("job", async () => undefined),
				tx.query("outside 3"),
			];
			proceed.open();
			await Promise.all([first, ...waiting]);
			// Nothing waits any more: this one is sent at once.
			await tx.query("after");
		});
		assert.deepEqual(log, [
			"begin",
			"tx exec: savepoint sqlkit_1",
			"tx: inside 1",
			"tx: inside 2",
			"tx exec: release sqlkit_1",
			"tx: outside 1",
			"tx exec: outside 2",
			"tx exec: savepoint sqlkit_1",
			"tx: second savepoint",
			"tx exec: release sqlkit_1",
			// The lock is taken in its turn; its release is issued once its callback is
			// done, so behind what was already waiting by then.
			"lock job in transaction",
			"tx: outside 3",
			"unlock job",
			"tx: after",
			"commit",
		]);
	});

	test("a scope ends only after the savepoints it did not await, whether it is kept or not", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend);
		const failed = new Error("the transaction failed");
		const unawaited: Promise<unknown>[] = [];
		await db.transaction(async (tx) => {
			unawaited.push(
				tx.savepoint(async (sp) => {
					await sleep(5);
					await sp.query("late 1");
				}),
			);
		});
		assert.equal(
			await rejection(
				"the transaction",
				db.transaction(async (tx) => {
					unawaited.push(
						tx.savepoint(async (sp) => {
							unawaited.push(
								sp.savepoint(async (nested) => {
									await sleep(5);
									await nested.query("late 2");
								}),
							);
						}),
					);
					throw failed;
				}),
			),
			failed,
		);
		await Promise.all(unawaited);
		assert.deepEqual(log, [
			"begin",
			"tx exec: savepoint sqlkit_1",
			"tx: late 1",
			"tx exec: release sqlkit_1",
			"commit",
			"begin",
			"tx exec: savepoint sqlkit_1",
			"tx exec: savepoint sqlkit_2",
			"tx: late 2",
			"tx exec: release sqlkit_2",
			"tx exec: release sqlkit_1",
			"rollback",
		]);
	});

	test("a context that outlived its savepoint is in the enclosing scope; past the transaction, a stranger", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend);
		const afterSavepoint = gate();
		const afterTransaction = gate();
		const stragglers: Promise<unknown>[] = [];
		await db.transaction(async (tx) => {
			await tx.savepoint(async () => {
				stragglers.push(
					afterSavepoint.opened.then(() => db.query("in the transaction")),
					afterTransaction.opened.then(() => db.query("a stranger")),
				);
			});
			afterSavepoint.open();
			await stragglers[0];
		});
		afterTransaction.open();
		await Promise.all(stragglers);
		assert.deepEqual(log, [
			"begin",
			"tx exec: savepoint sqlkit_1",
			"tx exec: release sqlkit_1",
			"tx: in the transaction",
			"commit",
			"backend: a stranger",
		]);
	});

	test("the sync tier asks its backend for one inside a transaction of either tier, on one stack of names", async () => {
		const { backend, log } = stub();
		const db = createSingleConnectionDriver(backend, syncStub(log));
		const sync = db.sync;
		assert.ok(sync !== undefined);
		// Outside a transaction it is a transaction.
		sync.savepoint((tx) => tx.query("top"));
		sync.transaction((tx) => {
			tx.savepoint((sp) => {
				sp.query("a");
				sp.savepoint((nested) => nested.query("b"));
			});
		});
		await db.transaction(async (tx) => {
			await tx.savepoint(async () => {
				sync.savepoint((sp) => sp.query("c"));
			});
			sync.savepoint((sp) => sp.query("d"));
		});
		assert.deepEqual(log, [
			"sync begin",
			"sync: top",
			"sync commit",
			"sync begin",
			"sync savepoint sqlkit_1",
			"sync: a",
			"sync savepoint sqlkit_2",
			"sync: b",
			"sync release sqlkit_2",
			"sync release sqlkit_1",
			"sync commit",
			"begin",
			"tx exec: savepoint sqlkit_1",
			"sync savepoint sqlkit_2",
			"sync: c",
			"sync release sqlkit_2",
			"tx exec: release sqlkit_1",
			"sync savepoint sqlkit_1",
			"sync: d",
			"sync release sqlkit_1",
			"commit",
		]);
	});

	test("pg: a failure inside a savepoint that rejects goes with it, and the transaction commits", async () => {
		const { backend, log } = aborting("pg");
		const db = createSingleConnectionDriver(backend);
		let failed: unknown;
		assert.equal(
			await db.transaction(async (tx) => {
				failed = await rejection(
					"the savepoint",
					tx.savepoint((sp) => sp.query("fail inside")),
				);
				return "committed";
			}),
			"committed",
		);
		assert.ok(failed instanceof BusyError, String(failed));
		assert.deepEqual(log, ["rollback to sqlkit_1", "commit"]);
	});

	test("pg: a failure its callback swallowed undoes the savepoint, with TransactionAbortedError", async () => {
		const { backend, log } = aborting("pg");
		const db = createSingleConnectionDriver(backend);
		let inner: unknown;
		let refusal: unknown;
		assert.equal(
			await db.transaction(async (tx) => {
				refusal = await rejection(
					"the savepoint",
					tx.savepoint(async (sp) => {
						inner = await rejection("a failure", sp.query("fail inside"));
						return "swallowed";
					}),
				);
				return "committed";
			}),
			"committed",
		);
		assert.ok(refusal instanceof TransactionAbortedError, String(refusal));
		assert.equal(refusal.kind, "aborted");
		assert.match(refusal.message, /inside the savepoint/);
		assert.ok(inner instanceof BusyError);
		assert.equal(refusal.cause, inner);
		// Rolled back to, not released; and the transaction, recovered, commits.
		assert.deepEqual(log, ["rollback to sqlkit_1", "commit"]);
	});

	test("pg: a statement not awaited inside a savepoint is waited for, and counted against it", async () => {
		const { backend, log } = aborting("pg");
		const db = createSingleConnectionDriver(backend);
		const refusal = await db.transaction((tx) =>
			rejection(
				"the savepoint",
				tx.savepoint(async (sp) => {
					void sp.query("fail not awaited").catch(() => undefined);
				}),
			),
		);
		assert.ok(refusal instanceof TransactionAbortedError, String(refusal));
		assert.deepEqual(log, ["rollback to sqlkit_1", "commit"]);
	});

	test("pg: a savepoint the database would not open, release or roll back to aborts the scope around it", async () => {
		for (const step of ["open", "release", "undo"] as const) {
			const { backend, log } = aborting("pg", { [step]: `fail ${step}` });
			const db = createSingleConnectionDriver(backend);
			let refusal: unknown;
			const error = await rejection(
				`the transaction (${step})`,
				db.transaction(async (tx) => {
					refusal = await rejection(
						`the savepoint (${step})`,
						tx.savepoint(async () => {
							if (step === "undo") throw new Error("the callback's own");
							return "value";
						}),
					);
					return "swallowed";
				}),
			);
			// The refusal is the database's, typed, not the callback's own error.
			assert.ok(refusal instanceof BusyError, `${step}: ${String(refusal)}`);
			assert.equal(refusal.message, `driver failed at fail ${step}`);
			// It is a failed statement of the transaction, which is then not committed.
			assert.ok(
				error instanceof TransactionAbortedError,
				`${step}: ${String(error)}`,
			);
			assert.equal(error.cause, refusal);
			assert.deepEqual(log, ["rollback"], step);
		}
	});

	test("pg: a savepoint rolled back to recovers the scope an inner refusal aborted", async () => {
		// The inner savepoint is not released; the outer one's callback swallows that.
		const { backend, log } = aborting("pg", {
			release: "fail release",
			only: "sqlkit_2",
		});
		const db = createSingleConnectionDriver(backend);
		let outer: unknown;
		assert.equal(
			await db.transaction(async (tx) => {
				outer = await rejection(
					"the outer savepoint",
					tx.savepoint(async (sp) => {
						await rejection(
							"the inner savepoint",
							sp.savepoint(async () => "value"),
						);
						return "swallowed";
					}),
				);
				return "committed";
			}),
			"committed",
		);
		assert.ok(outer instanceof TransactionAbortedError, String(outer));
		assert.deepEqual(log, ["rollback to sqlkit_1", "commit"]);
	});

	test("sqlite: a refused savepoint rejects, typed, and the transaction is its callback's to end", async () => {
		const { backend, log } = aborting("sqlite", { release: "fail release" });
		const db = createSingleConnectionDriver(backend);
		let refusal: unknown;
		assert.equal(
			await db.transaction(async (tx) => {
				refusal = await rejection(
					"the savepoint",
					tx.savepoint(async () => "value"),
				);
				return "committed";
			}),
			"committed",
		);
		assert.ok(refusal instanceof BusyError, String(refusal));
		assert.deepEqual(log, ["commit"]);
		// And a failure its callback swallowed is no failure of the savepoint: kept.
		const kept = aborting("sqlite");
		assert.equal(
			await createSingleConnectionDriver(kept.backend).transaction((tx) =>
				tx.savepoint(async (sp) => {
					await rejection("a failure", sp.query("fail inside"));
					return "kept";
				}),
			),
			"kept",
		);
		assert.deepEqual(kept.log, ["release sqlkit_1", "commit"]);
	});
});
