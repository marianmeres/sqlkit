// Every conformance body on the Durable Objects adapter, run inside workerd (plan doc
// 02 #7). `node:test` cannot run there, so `worker/conformance.ts` holds the bodies and
// runs one case per request; this file starts workerd once, asks it for the cases, and
// registers each as a `node:test` case under `describe("do")`, the adapter's name, as the
// other adapters' cases are registered under theirs. Each case goes to a fresh object, an
// empty database of its own.
//
// A case the `do` registry entry lists under `except` is not run: it is registered as
// skipped, with the finding that says why as the reason, so the report shows every one.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { startWorkerd } from "./_workerd.ts";

/** The bodies the worker must run, every one of `test/conformance/`. */
const BODIES = ["driver", "sync", "errors", "builders", "decoders", "migrate"];

interface Listed {
	name: string;
	except?: string;
}

interface Listing {
	bodies: Record<string, Listed[]>;
	unknownExceptions: string[];
}

const workerd = await startWorkerd(join(import.meta.dirname, "worker", "conformance.ts"));
after(async () => {
	await workerd.dispose();
	// nothing left behind: the port workerd listened on refuses connections
	await assert.rejects(fetch(workerd.url), "workerd still answers after dispose()");
});

let listing: Listing;
try {
	listing = (await workerd.call("cases")) as Listing;
} catch (error) {
	await workerd.dispose();
	throw error;
}

describe("do", () => {
	test("the worker runs every body, each with cases, and every exception names a case", () => {
		assert.deepEqual(Object.keys(listing.bodies), BODIES);
		for (const body of BODIES) {
			assert.ok((listing.bodies[body]?.length ?? 0) > 0, `${body}: no cases`);
		}
		assert.deepEqual(listing.unknownExceptions, [], "an exception names no case");
	});

	for (const body of BODIES) {
		for (const { name, except } of listing.bodies[body] ?? []) {
			if (except !== undefined) {
				test(name, { skip: `excepted on Durable Objects: ${except}` }, () => {});
				continue;
			}
			test(name, async () => {
				assert.equal(await workerd.call("run", { body, name }), null);
			});
		}
	}
});
