// What `package.json` says about the entry points: the reading the exports guard and the
// API docs guard share (exports.test.ts, api-docs.test.ts). Pure functions over a parsed
// manifest, so each guard can test them on a fabricated one.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The repository's root. */
export const ROOT: string = join(import.meta.dirname, "..", "..");

/** The parsed `package.json` at the root. */
export function readPackage(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

/** One file a subpath export points at, and where in `exports` it is. */
export interface Target {
	/** The condition path: `"./pg" import`, `"." types`. */
	readonly at: string;
	readonly target: string;
}

/**
 * Every file an `exports` entry points at, through any nesting of conditions. A value
 * that is neither a string nor an object of conditions is reported in `problems`.
 */
export function targetsOf(
	value: unknown,
	at: string,
): { targets: Target[]; problems: string[] } {
	if (typeof value === "string")
		return { targets: [{ at, target: value }], problems: [] };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {
			targets: [],
			problems: [`${at}: not a path or an object of conditions`],
		};
	}
	const targets: Target[] = [];
	const problems: string[] = [];
	for (const [condition, inner] of Object.entries(value)) {
		const found = targetsOf(inner, `${at} ${condition}`);
		targets.push(...found.targets);
		problems.push(...found.problems);
	}
	return { targets, problems };
}

/**
 * The source file the build emits a target from: `./dist/pg/mod.js` and
 * `./dist/pg/mod.d.ts` are `src/pg/mod.ts` (tsconfig.build.json maps `src` to `dist`).
 * Anything else is `null`.
 */
export function sourceOf(target: string): string | null {
	const match = /^\.\/dist\/((?:[\w-]+\/)*[\w-]+)\.(?:js|d\.ts)$/.exec(target);
	return match === null ? null : `src/${match[1]}.ts`;
}

/** One entry point: what a consumer imports, and the source it is built from. */
export interface EntryPoint {
	/** The subpath key: `"."`, `"./pg"`, `"./migrate/files"`. */
	readonly key: string;
	/** The import specifier: `@marianmeres/sqlkit/pg`. */
	readonly specifier: string;
	/** The source of the file it loads: `src/pg/mod.ts`; `null` when it maps to none. */
	readonly source: string | null;
}

/** The entry points `pkg.exports` declares, in its order. */
export function entryPointsOf(pkg: Record<string, unknown>): EntryPoint[] {
	const name = pkg.name;
	const exports = pkg.exports;
	if (typeof name !== "string" || typeof exports !== "object" || exports === null) {
		throw new TypeError("package.json has no name or no exports object");
	}
	return Object.entries(exports).map(([key, value]) => {
		const { targets } = targetsOf(value, key);
		const runtime =
			targets.find(({ at }) => at === `${key} default`) ??
			targets.find(({ at }) => at === `${key} import`) ??
			targets.find(({ at }) => at === key);
		return {
			key,
			specifier: `${name}${key.slice(1)}`,
			source: runtime === undefined ? null : sourceOf(runtime.target),
		};
	});
}
