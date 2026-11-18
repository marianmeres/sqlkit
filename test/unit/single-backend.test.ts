// The single-connection core against a stub backend (plan doc 02 #2): the parts of the
// seam no registered adapter exercises yet. node:sqlite hands its transaction callback
// itself and has no lock other processes honour; a backend whose library hands out a
// transaction object, and one with a lock, arrive with later adapters. The routing and the
// lock calls are the core's, so they are pinned here, on a backend that records what it
// was asked. No database.
//
// The sync tier's routing is pinned here too (plan doc 02 #3), along with the one moment
// of S4 no adapter can be timed into: after the async callback settled, before the
// backend committed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BusyError, SqlError, type SqlErrorInfo } from "../../src/mod.ts";
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
