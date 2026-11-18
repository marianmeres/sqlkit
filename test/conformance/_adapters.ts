// The registry of adapters every conformance body runs on (plan doc 02 #2).
//
// The list is static, not derived from the environment: an adapter that cannot be created
// is a failing case, never a silently shorter suite. Only `*.test.ts` files import it; a
// body receives its adapter as an argument, so that it can run where these imports cannot.
//
// The names are load-bearing: `pnpm run test:pg` and `pnpm run test:sqlite` select the
// cases of their adapters by the suite name they run under, which is the adapter's name,
// from the files of this directory and of the adapter's own (`test/pg/`, `test/sqlite/`),
// whose suites are named `<adapter>/<topic>`. The scripts read only those directories:
// Node runs the root-level `after` of a file the filter left empty before its async root
// `before` has resolved, so a file that starts a server there would leave it running.

import { openSqlite } from "../../src/sqlite/mod.ts";
import { createPgFixture } from "../pg/_fixture.ts";
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
	{
		// A pool on a fresh schema per case, dropped with CASCADE afterwards. A missing
		// TEST_PG_DATABASE fails each case: it does not drop the adapter.
		name: "pg",
		sync: false,
		create: (): Promise<Fixture> => createPgFixture(),
	},
];
