// A PGlite driver on an in-memory database of its own (plan doc 02 #6): what the `pglite`
// entry of the conformance registry creates for every case, and what the suites under
// `test/pglite/` create.
//
// Every fixture is a fresh instance. Creating one runs `initdb` (about half a second), so
// the first fixture of a process creates a seed instance, dumps its data directory once,
// and every fixture is then loaded from that dump (about a tenth of that): the same empty
// database, never shared, since each load is a copy.
//
// Imports no `node:test`: the conformance registry imports it, and the bodies it serves are
// runner-agnostic.

import { PGlite } from "@electric-sql/pglite";
import type { Driver } from "../../src/mod.ts";
import { createPgliteDriver } from "../../src/pglite/mod.ts";

export interface PgliteFixture {
	driver: Driver;
	/** The instance under the driver, for a case that looks at it directly. */
	pglite: PGlite;
	dispose(): Promise<void>;
}

/** The data directory of a freshly initialized database, dumped once per process. */
let seed: Promise<File | Blob> | undefined;

function seedDataDir(): Promise<File | Blob> {
	seed ??= (async () => {
		const db = await PGlite.create();
		try {
			return await db.dumpDataDir("none");
		} finally {
			await db.close();
		}
	})();
	// A failed seed is not kept: the next fixture tries again, and fails on its own.
	seed.catch(() => {
		seed = undefined;
	});
	return seed;
}

/** A fresh, empty in-memory PGlite: a copy of the seed's data directory. */
export async function freshPglite(): Promise<PGlite> {
	return PGlite.create({ loadDataDir: await seedDataDir() });
}

/** A driver on an in-memory database of its own, closed with it by `dispose()`. */
export async function createPgliteFixture(): Promise<PgliteFixture> {
	const pglite = await freshPglite();
	const driver = createPgliteDriver(pglite);
	return { driver, pglite, dispose: () => driver.close() };
}
