// The single-connection core against a stub backend (plan doc 02 #2): the parts of the
// seam no registered adapter exercises yet. node:sqlite hands its transaction callback
// itself and has no lock other processes honour; a backend whose library hands out a
// transaction object, and one with a lock, arrive with later adapters. The routing and the
// lock calls are the core's, so they are pinned here, on a backend that records what it
// was asked. No database.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Connection, SingleConnectionBackend } from "../../src/single/backend.ts";
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
