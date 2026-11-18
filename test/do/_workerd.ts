// A workerd harness for `node:test`. `node:test` cannot run inside workerd, so a test file
// starts one workerd (through Miniflare) in `before()`, sends each case into a Durable Object
// with `call()`, asserts on the answer in Node, and disposes of it in `after()`.
//
// The worker entry is a module that exports one SQLite-backed Durable Object class named
// `TestObject`. Its `fetch` receives `POST /<name>` with a JSON payload and answers with the
// JSON envelope `{ ok: true, value }` or `{ ok: false, error }`. The harness bundles the
// entry with esbuild (`node:*` and `cloudflare:*` stay imports, workerd provides them) and
// adds the default export that routes a request to the object it names.
//
// Every call goes to a fresh object, so to an empty database, unless it names one: two
// calls naming one object share its database and its single thread.
//
// The server listens on an OS-assigned port (D20), stores in memory only, and fetches
// nothing from the network.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/** The compatibility flags the adapter requires (D24). */
export const COMPATIBILITY_FLAGS: readonly string[] = ["nodejs_compat"];

/**
 * A fixed date, so behaviour does not move with the calendar. It has to be one the installed
 * workerd supports: no later than the date in its version (`1.YYYYMMDD.n`).
 */
export const COMPATIBILITY_DATE = "2026-07-01";

/** The Durable Object binding the router uses. */
const BINDING = "TEST_OBJECT";

/** The class every worker entry exports. */
const CLASS_NAME = "TestObject";

export interface CallOptions {
	/** The object to send the call to. A fresh one when absent. */
	object?: string;
}

export interface Workerd {
	/** Where the server listened. Refuses connections once disposed. */
	readonly url: URL;
	/** The installed workerd's version, for the findings. */
	readonly version: string;
	/**
	 * Sends `name` with `payload` (JSON) to a Durable Object and resolves to the handler's
	 * value. A handler that threw rejects with an `Error` carrying its name and message.
	 */
	call(name: string, payload?: unknown, options?: CallOptions): Promise<unknown>;
	/** Shuts the workerd process down. Idempotent. */
	dispose(): Promise<void>;
}

/** The error a handler threw, as the worker described it. */
export interface RemoteError {
	name: string;
	message: string;
	stack?: string;
}

/** The default export routing `POST /<name>?object=<object>` to that object. */
const ROUTER = `
export default {
	async fetch(request, env) {
		const object = new URL(request.url).searchParams.get("object");
		if (!object) return new Response("missing ?object=", { status: 400 });
		return env.${BINDING}.getByName(object).fetch(request);
	},
};
`;

/** The installed workerd's version, read from the copy Miniflare resolves. */
export function workerdVersion(): string {
	const fromMiniflare = createRequire(import.meta.resolve("miniflare"));
	const manifest = fromMiniflare.resolve("workerd/package.json");
	const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
	return version;
}

/** Bundles `entry` and the router into one ES module. */
async function bundle(entry: string): Promise<string> {
	const result = await build({
		stdin: {
			contents: `export { ${CLASS_NAME} } from ${JSON.stringify(entry)};\n${ROUTER}`,
			resolveDir: import.meta.dirname,
			sourcefile: "worker-entry.js",
			loader: "js",
		},
		bundle: true,
		format: "esm",
		platform: "neutral",
		external: ["node:*", "cloudflare:*"],
		write: false,
		logLevel: "silent",
	});
	const [output] = result.outputFiles;
	if (!output) throw new Error(`esbuild produced no output for ${entry}`);
	return output.text;
}

/** Starts workerd with the Durable Object exported by `entry` (an absolute path). */
export async function startWorkerd(entry: string): Promise<Workerd> {
	const script = await bundle(entry);
	const mf = new Miniflare({
		modules: [{ type: "ESModule", path: "worker.js", contents: script }],
		compatibilityDate: COMPATIBILITY_DATE,
		compatibilityFlags: [...COMPATIBILITY_FLAGS],
		durableObjects: { [BINDING]: { className: CLASS_NAME, useSQLite: true } },
		durableObjectsPersist: false,
		port: 0,
		cf: false,
	});

	let url: URL;
	try {
		url = await mf.ready;
	} catch (error) {
		await mf.dispose().catch(() => {});
		throw error;
	}

	let disposed: Promise<void> | undefined;
	return {
		url,
		version: workerdVersion(),
		async call(name, payload = null, options = {}) {
			const object = options.object ?? randomUUID();
			const target = new URL(`/${name}`, url);
			target.searchParams.set("object", object);
			const response = await mf.dispatchFetch(target.href, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const text = await response.text();
			let envelope: { ok: boolean; value?: unknown; error?: RemoteError };
			try {
				envelope = JSON.parse(text);
			} catch {
				throw new Error(`${name}: HTTP ${response.status}, not JSON: ${text}`);
			}
			if (envelope.ok) return envelope.value;
			const remote = envelope.error;
			const error = new Error(`${name}: ${remote?.name}: ${remote?.message}`);
			if (remote?.stack)
				error.stack = `${error.stack}\n--- in workerd ---\n${remote.stack}`;
			throw error;
		},
		dispose() {
			disposed ??= mf.dispose();
			return disposed;
		},
	};
}
