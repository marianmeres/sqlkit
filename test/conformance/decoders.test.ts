// Binds the `decoders` conformance body (rows written through the parameter rule, read back
// raw and decoded) to `node:test`, once per registered adapter, under
// `describe(adapter.name)`. Only `*.test.ts` files in this directory import `node:test`; the
// body itself runs anywhere (plan doc 03 #5).
import { describe, test } from "node:test";
import { ADAPTERS } from "./_adapters.ts";
import { decodersContract } from "./decoders.ts";

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		decodersContract({ test: (name, fn) => void test(name, () => fn()) }, adapter);
	});
}
