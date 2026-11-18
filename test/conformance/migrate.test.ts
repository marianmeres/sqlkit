// Binds the `migrate` conformance body (the migrate wiring over a `Driver`) to `node:test`,
// once per registered adapter, under `describe(adapter.name)`. Only `*.test.ts` files in
// this directory import `node:test`; the body itself runs anywhere (plan doc 03 #2).
import { describe, test } from "node:test";
import { ADAPTERS } from "./_adapters.ts";
import { migrateContract } from "./migrate.ts";

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		migrateContract({ test: (name, fn) => void test(name, () => fn()) }, adapter);
	});
}
