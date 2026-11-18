// The registry of adapters every conformance body runs on (plan doc 02 #2).
//
// The list is static, not derived from the environment: an adapter that cannot be created
// is a failing case, never a silently shorter suite. Only `*.test.ts` files import it; a
// body receives its adapter as an argument, so that it can run where these imports cannot.

import { openSqlite } from "../../src/sqlite/mod.ts";
import type { AdapterCase, Fixture } from "./_suite.ts";

export const ADAPTERS: readonly AdapterCase[] = [
	{
		// A fresh in-memory database per case.
		name: "sqlite",
		sync: true,
		create(): Promise<Fixture> {
			const driver = openSqlite();
			return Promise.resolve({ driver, dispose: () => driver.close() });
		},
	},
];
