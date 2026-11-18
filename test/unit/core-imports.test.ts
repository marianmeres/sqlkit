// The core is runtime-neutral, checked rather than reviewed: every file under `src/core/`,
// and the root entry point `src/mod.ts` that re-exports it, imports only files under
// `src/core/`. No `node:*`, no bare package (not even for its types), no path that climbs
// out, no `require` and no import whose specifier is computed. That is what lets the root
// entry point load in a Worker as well as in Node.
//
// Comments are stripped first, so a doc comment that names a forbidden module is not read
// as code. The checker is tested on fabricated sources as well, so a scan that silently
// finds nothing cannot pass for a clean core.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const CORE = join(ROOT, "src", "core");
const ENTRY = join(ROOT, "src", "mod.ts");

/** Every source file the rule covers, as absolute paths. */
function coveredFiles(): string[] {
	const files = readdirSync(CORE, { recursive: true })
		.map((entry) => String(entry))
		.filter((path) => /\.[cm]?[jt]s$/.test(path))
		.map((path) => join(CORE, path));
	return [ENTRY, ...files.sort()];
}

/**
 * Drop comments. Block comments first; a `//` is a line comment only when it is not part
 * of a `scheme://` run inside a string.
 */
function stripComments(source: string): string {
	return source
		.replaceAll(/\/\*[\s\S]*?\*\//g, "")
		.replaceAll(/(^|[^:/])\/\/[^\n]*/g, "$1");
}

/** The offenses of one file's source: one line each, empty when the file is clean. */
function offenses(file: string, source: string): string[] {
	const code = stripComments(source);
	const found: string[] = [];
	const specifiers: string[] = [];
	for (const pattern of [
		/(?<![\w$.])from\s*(["'])([^"'\n]*)\1/g, // import … from "x", export … from "x"
		/(?<![\w$.])import\s*(["'])([^"'\n]*)\1/g, // import "x"
		/(?<![\w$.])import\s*\(\s*(["'])([^"'\n]*)\1\s*[,)]/g, // import("x")
	]) {
		for (const match of code.matchAll(pattern)) specifiers.push(match[2] ?? "");
	}
	const dynamic = code.match(/(?<![\w$.])import\s*\(/g)?.length ?? 0;
	const literal = code.match(/(?<![\w$.])import\s*\(\s*["']/g)?.length ?? 0;
	if (dynamic > literal) found.push("import() with a computed specifier");
	if (/(?<![\w$.])require\s*\(/.test(code)) found.push("require()");
	for (const specifier of specifiers) {
		if (specifier.startsWith("node:")) {
			found.push(`${specifier}: a Node built-in`);
		} else if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			found.push(`${specifier}: not a relative path`);
		} else if (!resolve(dirname(file), specifier).startsWith(CORE + sep)) {
			found.push(`${specifier}: outside src/core/`);
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
		const source = readFileSync(ENTRY, "utf8");
		assert.deepEqual(offenses(ENTRY, source), []);
		assert.deepEqual(offenses(join(ROOT, "elsewhere", "x", "mod.ts"), source), [
			"./core/sql.ts: outside src/core/",
		]);
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
