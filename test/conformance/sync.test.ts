// Binds the `sync` conformance body (the sync tier, S1–S6) to `node:test`, once per
// registered adapter, under `describe(adapter.name)`. An adapter without a sync tier is
// held to having none. Only `*.test.ts` files in this directory import `node:test`; the
// body itself runs anywhere (plan doc 02 #3).
import { describe, test } from "node:test";
import { ADAPTERS } from "./_adapters.ts";
import { syncContract } from "./sync.ts";

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		syncContract({ test: (name, fn) => void test(name, () => fn()) }, adapter);
	});
}
