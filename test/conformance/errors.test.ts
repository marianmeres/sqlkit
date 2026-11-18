// Binds the `errors` conformance body (typed errors end to end) to `node:test`, once per
// registered adapter, under `describe(adapter.name)`. Only `*.test.ts` files in this
// directory import `node:test`; the body itself runs anywhere (plan doc 01 #4).
import { describe, test } from "node:test";
import { ADAPTERS } from "./_adapters.ts";
import { errorsContract } from "./errors.ts";

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		errorsContract({ test: (name, fn) => void test(name, () => fn()) }, adapter);
	});
}
