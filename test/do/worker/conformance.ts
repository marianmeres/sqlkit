// The conformance bodies inside workerd (plan doc 02 #7). `node:test` does not run there,
// so this Durable Object collects the cases of a body into an in-memory `Suite` and runs
// one of them against `createDoDriver(ctx.storage)`; `test/do/conformance.test.ts` sends
// each case to a fresh object, so to an empty database, and turns each answer into a
// `node:test` case under `describe("do")`.
//
// Two handlers: `cases` lists every body's cases, each excepted one with its reason, and
// the `except` entries that name no case; `run` runs one case and answers `null`, or
// throws what it threw. An excepted case is never run: the reasons below are findings
// about workerd, each pinned by `test/do/probe.test.ts`, so a workerd that changes one
// fails there first.
//
// This is the registry entry of the `do` adapter: `test/conformance/_adapters.ts` lists
// the adapters Node runs, and cannot list this one, whose database exists only here.

import type { DurableObjectState } from "cloudflare:workers";
import { DurableObject } from "cloudflare:workers";
import { createDoDriver } from "../../../src/do/mod.ts";
import type { AdapterCase, Fixture, Suite } from "../../conformance/_suite.ts";
import { buildersContract } from "../../conformance/builders.ts";
import { decodersContract } from "../../conformance/decoders.ts";
import { driverContract } from "../../conformance/driver.ts";
import { errorsContract } from "../../conformance/errors.ts";
import { migrateContract } from "../../conformance/migrate.ts";
import { syncContract } from "../../conformance/sync.ts";

/** Every body, by the name `test/do/conformance.test.ts` asks for. */
const BODIES: Readonly<Record<string, (suite: Suite, adapter: AdapterCase) => void>> = {
	driver: driverContract,
	sync: syncContract,
	errors: errorsContract,
	builders: buildersContract,
	decoders: decodersContract,
	migrate: migrateContract,
};

/** What a deferred constraint does on Durable Objects (F15), for both cases it decides. */
const DEFERRED =
	"F15: workerd checks a deferred constraint when the request's implicit transaction " +
	"commits, not when transaction() ends; a violation resets the object and fails the " +
	"request, so there is no rejection to type";

/** The cases that cannot hold on Durable Objects, each with the finding that says why. */
const EXCEPT: Readonly<Record<string, string>> = {
	"R11: query refuses a text of several statements, and none of it runs":
		"F01: sql.exec runs every statement of a text given no values, and workerd has no " +
		"call that refuses a text of several before any of it runs",
	"errors: a constraint COMMIT checks rejects the transaction, typed; nothing is kept":
		DEFERRED,
	"errors: a constraint a sync COMMIT checks throws, typed; nothing is kept": DEFERRED,
};

/** The `do` adapter, over one object's storage. */
function adapterOver(ctx: DurableObjectState): AdapterCase {
	return {
		name: "do",
		sync: true,
		except: EXCEPT,
		create(): Promise<Fixture> {
			const driver = createDoDriver(ctx.storage);
			return Promise.resolve({ driver, dispose: () => driver.close() });
		},
	};
}

/** The cases of `body`, by name, as it registers them for `adapter`. */
function casesOf(
	body: string,
	adapter: AdapterCase,
): Map<string, () => void | Promise<void>> {
	const register = BODIES[body];
	if (register === undefined) throw new TypeError(`no body named "${body}"`);
	const cases = new Map<string, () => void | Promise<void>>();
	register(
		{
			test(name, fn) {
				if (cases.has(name))
					throw new Error(`${body}: two cases named "${name}"`);
				cases.set(name, fn);
			},
		},
		adapter,
	);
	return cases;
}

/** One listed case: its name, and the reason it is excepted, if it is. */
interface Listed {
	name: string;
	except?: string;
}

type Handler = (ctx: DurableObjectState, payload: unknown) => unknown;

const handlers: Record<string, Handler> = {
	cases(ctx) {
		const adapter = adapterOver(ctx);
		const except = adapter.except ?? {};
		const named = new Set<string>();
		const bodies: Record<string, Listed[]> = {};
		for (const body of Object.keys(BODIES)) {
			bodies[body] = [...casesOf(body, adapter).keys()].map((name) => {
				named.add(name);
				const reason = except[name];
				return reason === undefined ? { name } : { name, except: reason };
			});
		}
		const unknownExceptions = Object.keys(except).filter((name) => !named.has(name));
		return { bodies, unknownExceptions };
	},

	async run(ctx, payload) {
		const { body, name } = payload as { body: string; name: string };
		const adapter = adapterOver(ctx);
		if (adapter.except?.[name] !== undefined) {
			throw new TypeError(
				`"${name}" is excepted on Durable Objects: it is not run`,
			);
		}
		const fn = casesOf(body, adapter).get(name);
		if (fn === undefined) throw new TypeError(`${body}: no case named "${name}"`);
		await fn();
		return null;
	},
};

export class TestObject extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
		const handler = handlers[name];
		if (!handler) {
			return Response.json({
				ok: false,
				error: { name: "TypeError", message: `no handler named "${name}"` },
			});
		}
		try {
			const payload: unknown = await request.json();
			const value = await handler(this.ctx, payload);
			return Response.json({ ok: true, value });
		} catch (error) {
			return Response.json({ ok: false, error: describe(error) });
		}
	}
}

/** What a case threw, as the harness reports it: name, message and stack. */
function describe(error: unknown): { name: string; message: string; stack?: string } {
	if (error instanceof Error) {
		const cause = error.cause === undefined ? "" : `\ncause: ${String(error.cause)}`;
		return {
			name: error.name,
			message: `${error.message}${cause}`,
			...(error.stack === undefined ? {} : { stack: error.stack }),
		};
	}
	return { name: typeof error, message: String(error) };
}
