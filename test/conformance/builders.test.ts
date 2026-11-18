// Binds the `builders` conformance body (the statement builders, executed) to `node:test`,
// once per registered adapter, under `describe(adapter.name)`. Only `*.test.ts` files in
// this directory import `node:test`; the body itself runs anywhere (plan doc 03 #1).
import { describe, test } from "node:test";
import { ADAPTERS } from "./_adapters.ts";
import { buildersContract } from "./builders.ts";

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		buildersContract({ test: (name, fn) => void test(name, () => fn()) }, adapter);
	});
}
