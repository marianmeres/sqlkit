// The conformance harness's three shapes, runner-agnostic (plan doc 02 #2, D20).
//
// A conformance body is a function `(suite, adapter) => void` that registers its cases on
// a `Suite`. It imports nothing from `node:test`: under Node a `*.test.ts` file binds the
// suite to `node:test`, and inside workerd an in-memory suite collects the same cases and
// runs them there, where `node:test` does not exist. Assertions use `node:assert/strict`,
// which loads in both.

import type { Driver } from "../../src/mod.ts";

/** Where a body registers its cases: `node:test`, or a collector inside workerd. */
export interface Suite {
	test(name: string, fn: () => void | Promise<void>): void;
}

/** One case's database, and how to get rid of it. */
export interface Fixture {
	driver: Driver;
	dispose(): Promise<void>;
}

/** An adapter the bodies run on. */
export interface AdapterCase {
	/** `"sqlite"`, later `"pg"`, `"pg-client"`, `"pglite"`, `"do"`. */
	readonly name: string;
	/**
	 * Whether its driver has a sync tier (`driver.sync`). Stated, not read from the
	 * driver, so that the `sync` body can hold the driver to it: a tier that went missing
	 * fails, it does not shorten the suite.
	 */
	readonly sync: boolean;
	/** A database isolated from every other case: each case creates and disposes one. */
	create(): Promise<Fixture>;
}
