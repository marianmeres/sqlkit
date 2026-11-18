// Binds the `driver` conformance body (R1–R10) to `node:test`, once per registered adapter,
// under `describe(adapter.name)`. Only `*.test.ts` files in this directory import
// `node:test`; the body itself runs anywhere (plan doc 02 #2).
import { describe, test } from "node:test";
import { ADAPTERS } from "./_adapters.ts";
import { driverContract } from "./driver.ts";

for (const adapter of ADAPTERS) {
	describe(adapter.name, () => {
		driverContract({ test: (name, fn) => void test(name, () => fn()) }, adapter);
	});
}
