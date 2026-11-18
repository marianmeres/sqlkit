// The Durable Objects adapter's own suite, run in workerd through `_workerd.ts`. Each check
// is in `worker/adapter.ts` and asserts there; this file sends each to a fresh object.
//
// Adapter-specific because each is how this adapter meets the contract where workerd
// differs, not a rule every adapter shares: read-only enforced by detecting a write after
// it ran (F12) rather than refused before it, so a callback that swallows the refusal still
// gets a rejection, which node:sqlite and Postgres do not give; reads that sort or group,
// checked not to count as writes; a write that is not the last statement of a text, which
// only `total_changes()` sees; a `bigint` bound as a number (F09); and a `close()` that
// leaves the object's storage as it was.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startWorkerd, type Workerd } from "./_workerd.ts";

let workerd: Workerd | undefined;

before(async () => {
	workerd = await startWorkerd(join(import.meta.dirname, "worker", "adapter.ts"));
});

after(async () => {
	if (!workerd) return;
	await workerd.dispose();
	await assert.rejects(fetch(workerd.url), "workerd still answers after dispose()");
});

function check(name: string): Promise<unknown> {
	assert.ok(workerd, "workerd did not start");
	return workerd.call(name);
}

describe("do/adapter", () => {
	test("its name, dialect and capabilities; anything but storage is a TypeError", async () => {
		assert.equal(await check("shape"), null);
	});

	test("read-only: reads that sort, group, dedupe or number rows are not refused", async () => {
		assert.equal(await check("readsAreNotRefused"), null);
	});

	test("read-only: a write the callback swallowed still rolls back, and the transaction rejects", async () => {
		assert.equal(await check("swallowedWriteRollsBack"), null);
	});

	test("read-only: a write that is not the last statement of a text is refused", async () => {
		assert.equal(await check("writeBeforeTheLastStatement"), null);
	});

	test("bigint: one in the safe-integer range binds as that number; any other is a TypeError", async () => {
		assert.equal(await check("bigints"), null);
	});

	test("close() ends the driver and leaves the object's storage as it was", async () => {
		assert.equal(await check("closeLeavesTheStorage"), null);
	});
});
