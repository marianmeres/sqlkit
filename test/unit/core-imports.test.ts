// The core is runtime-neutral, checked rather than reviewed: every file under `src/core/`,
// and the root entry point `src/mod.ts` that re-exports it, imports only files under
// `src/core/`. No `node:*`, no bare package (not even for its types), no path that climbs
// out, no `require` and no import whose specifier is computed. That is what lets the root
// entry point load in a Worker as well as in Node.
//
// The single-connection driver core, `src/single/`, is held to the same rule with one
// built-in allowed: `node:async_hooks`, for the `AsyncLocalStorage` that carries a
// transaction (plan doc 02 #2). It imports the core and itself, and nothing else.
//
// Comments are stripped first, so a doc comment that names a forbidden module is not read
// as code. The checker is tested on fabricated sources as well, so a scan that silently
// finds nothing cannot pass for a clean core.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { importsOf } from "./_imports.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const CORE = join(ROOT, "src", "core");
const SINGLE = join(ROOT, "src", "single");
const ENTRY = join(ROOT, "src", "mod.ts");

/** What the files of one directory may import. */
interface Rule {
	/** Directories a relative import may resolve into. */
	readonly within: readonly string[];
	/** The one place it says so in an offense: `src/core/`. */
	readonly label: string;
	/** Built-ins allowed by name. */
	readonly builtins: ReadonlySet<string>;
}

const CORE_RULE: Rule = { within: [CORE], label: "src/core/", builtins: new Set() };
const SINGLE_RULE: Rule = {
	within: [CORE, SINGLE],
	label: "src/core/ or src/single/",
	builtins: new Set(["node:async_hooks"]),
};

/** Every source file under `dir`, as absolute paths. */
function sourcesIn(dir: string): string[] {
	return readdirSync(dir, { recursive: true })
		.map((entry) => String(entry))
		.filter((path) => /\.[cm]?[jt]s$/.test(path))
		.map((path) => join(dir, path))
		.sort();
}

/** Every source file the core rule covers, as absolute paths. */
function coveredFiles(): string[] {
	return [ENTRY, ...sourcesIn(CORE)];
}

/** The offenses of one file's source: one line each, empty when the file is clean. */
function offenses(file: string, source: string, rule: Rule = CORE_RULE): string[] {
	const imports = importsOf(source);
	const found: string[] = [];
	if (imports.computed) found.push("import() with a computed specifier");
	if (imports.require) found.push("require()");
	for (const specifier of imports.specifiers) {
		if (specifier.startsWith("node:")) {
			if (!rule.builtins.has(specifier))
				found.push(`${specifier}: a Node built-in`);
		} else if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			found.push(`${specifier}: not a relative path`);
		} else {
			const target = resolve(dirname(file), specifier);
			if (!rule.within.some((dir) => target.startsWith(dir + sep))) {
				found.push(`${specifier}: outside ${rule.label}`);
			}
		}
	}
	return found;
}

describe("unit/core-imports", () => {
	test("the walk sees the entry point and the core, not an empty directory", () => {
		const files = coveredFiles().map((file) =>
			relative(ROOT, file).replaceAll(sep, "/"),
		);
		assert.ok(files.includes("src/mod.ts"), files.join(", "));
		assert.ok(files.includes("src/core/sql.ts"), files.join(", "));
	});

	test("no covered file imports anything but a file under src/core/", () => {
		const found: string[] = [];
		for (const file of coveredFiles()) {
			for (const offense of offenses(file, readFileSync(file, "utf8"))) {
				found.push(`${relative(ROOT, file)}: ${offense}`);
			}
		}
		assert.deepEqual(found, []);
	});

	test("the entry point does import the core: the scan reads its specifiers", () => {
		// A scan that matched nothing would also report no offense; this one must see the
		// re-export, which it flags once the file is pretended to sit outside the root.
		// Every re-export is flagged, and only those: the list grows with the core.
		const source = readFileSync(ENTRY, "utf8");
		assert.deepEqual(offenses(ENTRY, source), []);
		const moved = offenses(join(ROOT, "elsewhere", "x", "mod.ts"), source);
		assert.ok(moved.includes("./core/sql.ts: outside src/core/"), moved.join(", "));
		assert.ok(
			moved.includes("./core/errors.ts: outside src/core/"),
			moved.join(", "),
		);
		for (const offense of moved) {
			assert.match(offense, /^\.\/core\/[\w-]+\.ts: outside src\/core\/$/);
		}
	});

	test("the checker flags each kind of offense", () => {
		const file = join(CORE, "fabricated.ts");
		const cases: [string, string[]][] = [
			['import { readFileSync } from "node:fs";', ["node:fs: a Node built-in"]],
			["import fs from 'fs';", ["fs: not a relative path"]],
			['import type { Client } from "pg";', ["pg: not a relative path"]],
			['export * from "../mod.ts";', ["../mod.ts: outside src/core/"]],
			[
				'export { x } from "../single/driver.ts";',
				["../single/driver.ts: outside src/core/"],
			],
			['import "node:async_hooks";', ["node:async_hooks: a Node built-in"]],
			['const m = await import("node:fs");', ["node:fs: a Node built-in"]],
			["const m = await import(name);", ["import() with a computed specifier"]],
			['const m = require("./sql.ts");', ["require()"]],
			[
				'import {\n\tsql,\n\traw,\n} from "pg-format";',
				["pg-format: not a relative path"],
			],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(offenses(file, source), expected, source);
		}
	});

	test("the checker passes what is allowed and ignores comments", () => {
		const file = join(CORE, "fabricated.ts");
		const clean = [
			'import { sql } from "./sql.ts";',
			"import type { Sql } from './sql.ts';",
			'export * from "./errors.ts";',
			'import "./side-effect.ts";',
			'import { x } from "./nested/deeper.ts";',
			'import { y } from "../core/sql.ts";',
			'const m = await import("./lazy.ts");',
			'// import fs from "node:fs";',
			'/** import { Client } from "pg"; */',
			'/*\n * export * from "../mod.ts";\n */',
			'const url = "https://example.com"; // from "node:fs"',
			"const meta = import.meta.url;",
		];
		for (const source of clean) {
			assert.deepEqual(offenses(file, source), [], source);
		}
	});
});

describe("unit/core-imports: the single-connection core", () => {
	test("the walk sees the single-connection core", () => {
		const files = sourcesIn(SINGLE).map((file) =>
			relative(ROOT, file).replaceAll(sep, "/"),
		);
		assert.ok(files.includes("src/single/driver.ts"), files.join(", "));
		assert.ok(files.includes("src/single/backend.ts"), files.join(", "));
	});

	test("src/single/ imports node:async_hooks, the core and itself, nothing else", () => {
		const found: string[] = [];
		for (const file of sourcesIn(SINGLE)) {
			for (const offense of offenses(
				file,
				readFileSync(file, "utf8"),
				SINGLE_RULE,
			)) {
				found.push(`${relative(ROOT, file)}: ${offense}`);
			}
		}
		assert.deepEqual(found, []);
		// And it does use what it is allowed: the scan reads its specifiers.
		const driver = importsOf(readFileSync(join(SINGLE, "driver.ts"), "utf8"));
		assert.ok(
			driver.specifiers.includes("node:async_hooks"),
			driver.specifiers.join(),
		);
	});

	test("node:async_hooks is allowed in src/single/ and nowhere in src/core/", () => {
		const source = 'import { AsyncLocalStorage } from "node:async_hooks";';
		assert.deepEqual(
			offenses(join(SINGLE, "fabricated.ts"), source, SINGLE_RULE),
			[],
		);
		assert.deepEqual(offenses(join(CORE, "fabricated.ts"), source), [
			"node:async_hooks: a Node built-in",
		]);
	});

	test("the checker flags anything else in src/single/", () => {
		const file = join(SINGLE, "fabricated.ts");
		const cases: [string, string[]][] = [
			['import { readFileSync } from "node:fs";', ["node:fs: a Node built-in"]],
			[
				'import type { DatabaseSync } from "node:sqlite";',
				["node:sqlite: a Node built-in"],
			],
			['import type { Client } from "pg";', ["pg: not a relative path"]],
			[
				'import { openSqlite } from "../sqlite/mod.ts";',
				["../sqlite/mod.ts: outside src/core/ or src/single/"],
			],
			[
				'export * from "../mod.ts";',
				["../mod.ts: outside src/core/ or src/single/"],
			],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(offenses(file, source, SINGLE_RULE), expected, source);
		}
		const clean = [
			'import { statementOf } from "../core/contract.ts";',
			'import type { Connection } from "./backend.ts";',
		];
		for (const source of clean) {
			assert.deepEqual(offenses(file, source, SINGLE_RULE), [], source);
		}
	});
});
