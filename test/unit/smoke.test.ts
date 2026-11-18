// The suite runs and the root entry point loads. Placeholder until the first real module
// lands; delete it then.
import assert from "node:assert/strict";
import { test } from "node:test";

test("the root entry point loads", async () => {
	const mod = await import("../../src/mod.ts");
	assert.equal(typeof mod, "object");
});
