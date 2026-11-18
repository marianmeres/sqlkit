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

// ── The classifiers alone read a driver's error fields (plan doc 01 #4) ─────────────
//
// Which kind a driver's error is, is decided in one place per dialect: `classify-pg.ts`
// and `classify-sqlite.ts`. Everywhere else an adapter hands what it caught to `toSqlError`
// and decides nothing by `code`, `errcode` or `constraint`, so no `catch` in `src/` outside
// those two files reads one: not as a property (`.code`, `?.code`), not by name
// (`["code"]`, `"code" in e`), and not by destructuring (`{ code } = e`, `catch ({ code })`).
//
// The scan reads code only: comments, string and template text and regular expressions
// are blanked first, a template's `${…}` kept, so a brace or a `.code` inside a message is
// neither a block nor a read. A string that is one bare word is kept, since `"code"` is how
// a read by name is spelled.

const SRC = join(ROOT, "src");
const CLASSIFIERS = new Set([
	join(CORE, "classify-pg.ts"),
	join(CORE, "classify-sqlite.ts"),
]);

/** Keywords after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX =
	/(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|await|yield)$/;

/**
 * `source` as code alone: comments removed, the text of every string, template and regular
 * expression literal replaced by spaces (newlines kept), a template's `${…}` kept as code,
 * and a string that is one bare word kept as it is.
 */
function codeOnly(source: string): string {
	let out = "";
	let at = 0;
	// For each open `{`: whether it opened a template's `${`, whose `}` resumes the text.
	const braces: boolean[] = [];
	// The last character of code that is not a space: tells a regex from a division.
	let last = "";
	const blank = (c: string): string => (c === "\n" ? "\n" : " ");
	/** Template text, from `at` to its closing backtick or its next `${`. */
	const templateText = (): void => {
		while (at < source.length) {
			const c = source[at] ?? "";
			if (c === "\\") {
				out += blank(c) + blank(source[at + 1] ?? "");
				at += 2;
			} else if (c === "`") {
				out += c;
				at += 1;
				last = c;
				return;
			} else if (c === "$" && source[at + 1] === "{") {
				out += "${";
				at += 2;
				braces.push(true);
				last = "{";
				return;
			} else {
				out += blank(c);
				at += 1;
			}
		}
	};
	while (at < source.length) {
		const c = source[at] ?? "";
		const next = source[at + 1] ?? "";
		if (c === "/" && next === "/") {
			while (at < source.length && source[at] !== "\n") at += 1;
		} else if (c === "/" && next === "*") {
			const end = source.indexOf("*/", at + 2);
			const stop = end < 0 ? source.length : end + 2;
			out += source.slice(at, stop).replaceAll(/[^\n]/g, " ");
			at = stop;
		} else if (c === '"' || c === "'") {
			let end = at + 1;
			while (end < source.length && source[end] !== c && source[end] !== "\n") {
				end += source[end] === "\\" ? 2 : 1;
			}
			const text = source.slice(at + 1, end);
			out +=
				c + (/^[\w$]+$/.test(text) ? text : text.replaceAll(/[^\n]/g, " ")) + c;
			at = end + 1;
			last = c;
		} else if (c === "`") {
			out += c;
			at += 1;
			templateText();
		} else if (
			c === "/" &&
			(/^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || BEFORE_REGEX.test(out.trimEnd()))
		) {
			out += c;
			at += 1;
			let inClass = false;
			while (at < source.length && source[at] !== "\n") {
				const r = source[at] ?? "";
				if (r === "\\") {
					out += "  ";
					at += 2;
					continue;
				}
				if (!inClass && r === "/") break;
				if (r === "[") inClass = true;
				else if (r === "]") inClass = false;
				out += " ";
				at += 1;
			}
			out += "/";
			at += 1;
			while (/[a-z]/i.test(source[at] ?? "")) {
				out += source[at];
				at += 1;
			}
			last = "/";
		} else if (c === "}" && braces.at(-1) === true) {
			braces.pop();
			out += c;
			at += 1;
			templateText();
		} else {
			if (c === "{") braces.push(false);
			else if (c === "}") braces.pop();
			out += c;
			at += 1;
			if (!/\s/.test(c)) last = c;
		}
	}
	return out;
}

/** The index of the bracket that closes the one at `open`, in code with no literals left. */
function closing(code: string, open: number): number {
	const opener = code[open];
	const closer = opener === "(" ? ")" : "}";
	let depth = 0;
	for (let at = open; at < code.length; at += 1) {
		if (code[at] === opener) depth += 1;
		else if (code[at] === closer && --depth === 0) return at;
	}
	return code.length - 1;
}

/**
 * The code of every `catch` in `code`: a `catch (e) { … }` clause from its parameter to
 * the end of its block, and a `.catch(…)` call's arguments.
 */
function catchRegions(code: string): string[] {
	const regions: string[] = [];
	for (const match of code.matchAll(/(?<![\w$])catch(?![\w$])/g)) {
		let at = match.index + "catch".length;
		while (/\s/.test(code[at] ?? "")) at += 1;
		const start = at;
		if (/\??\.\s*$/.test(code.slice(0, match.index))) {
			if (code[at] === "(") regions.push(code.slice(start, closing(code, at) + 1));
			continue;
		}
		if (code[at] === "(") {
			at = closing(code, at) + 1;
			while (/\s/.test(code[at] ?? "")) at += 1;
		}
		if (code[at] === "{") regions.push(code.slice(start, closing(code, at) + 1));
	}
	return regions;
}

/** The fields only a classifier reads. */
const FIELD = "(?:code|errcode|constraint)";
const READS: readonly [string, RegExp][] = [
	["a property", new RegExp(`(?:\\?\\.|\\.)\\s*${FIELD}(?![\\w$])`)],
	["a name", new RegExp(`(["'\`])${FIELD}\\1`)],
	[
		"destructuring",
		new RegExp(
			`\\{[^{}]*(?<![\\w$.])${FIELD}(?![\\w$])[^{}]*\\}\\s*(?:=(?![=>])|\\))`,
		),
	],
];

/** How each `catch` in `source` reads a driver's error field: one line each. */
function fieldReads(source: string): string[] {
	const found: string[] = [];
	for (const region of catchRegions(codeOnly(source))) {
		for (const [how, pattern] of READS) {
			const read = pattern.exec(region);
			if (read !== null) found.push(`a catch reads ${how}: ${read[0].trim()}`);
		}
	}
	return found;
}

describe("unit/core-imports: only the classifiers read a driver's error fields", () => {
	test("no catch in src/ outside the two classifiers reads code, errcode or constraint", () => {
		const files = sourcesIn(SRC).filter((file) => !CLASSIFIERS.has(file));
		const found: string[] = [];
		let catches = 0;
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			catches += catchRegions(codeOnly(source)).length;
			for (const read of fieldReads(source)) {
				found.push(`${relative(ROOT, file).replaceAll(sep, "/")}: ${read}`);
			}
		}
		assert.deepEqual(found, []);
		// The scan sees the adapters' catches: one that found none would also find no read.
		const shown = files.map((file) => relative(ROOT, file).replaceAll(sep, "/"));
		for (const expected of [
			"src/pg/pool.ts",
			"src/single/driver.ts",
			"src/sqlite/mod.ts",
		]) {
			assert.ok(shown.includes(expected), shown.join(", "));
		}
		assert.ok(catches >= 15, `only ${catches} catches seen in src/`);
		// And the classifiers, which it leaves out, do read them.
		for (const file of CLASSIFIERS) {
			assert.match(codeOnly(readFileSync(file, "utf8")), /fields\.(code|errcode)/);
		}
	});

	test("the scan flags each way a catch reads a field", () => {
		const cases: [string, string][] = [
			[
				"try { x(); } catch (error) { if (error.code === '23505') y(); }",
				"a property: .code",
			],
			["try { x(); } catch (e) { return e?.errcode; }", "a property: ?.errcode"],
			[
				"try {} catch (e) {\n\tconst c = (e as Err).constraint;\n}",
				"a property: .constraint",
			],
			["try {} catch (e) { if ('code' in e) y(); }", "a name: 'code'"],
			['try {} catch (e) { return e["errcode"]; }', 'a name: "errcode"'],
			[
				"try {} catch (e) { const { code, message } = e; }",
				"destructuring: { code, message } =",
			],
			[
				"try {} catch ({ constraint }) { y(constraint); }",
				"destructuring: { constraint })",
			],
			["p.catch((e) => e.code === 'x')", "a property: .code"],
			["p.catch(({ errcode }) => errcode)", "destructuring: { errcode })"],
			[
				`p\n\t.catch((e) => {\n\t\tthrow \`\${e.code}\`;\n\t})`,
				"a property: .code",
			],
			["try {} catch (e) { if (e) { if (e) { e.code; } } }", "a property: .code"],
		];
		for (const [source, expected] of cases) {
			assert.deepEqual(fieldReads(source), [`a catch reads ${expected}`], source);
		}
	});

	test("the scan passes what is not a catch reading a field", () => {
		const clean = [
			// Outside a catch: the classifiers and the error classes read their own fields.
			"const kind = KIND_OF_CODE.get(fields.code);",
			"this.code = info.code; this.constraint = info.constraint;",
			// Inside one, but not a read: comments, messages, other fields.
			"try {} catch (e) { // e.code\n throw wrap(e); }",
			"try {} catch (e) { /* e.errcode */ throw wrap(e); }",
			"try {} catch (e) { throw new Error('see error.code, { code } = e'); }",
			`try {} catch (e) { throw new Error(\`no \${'e'}.code here\`); }`,
			"try {} catch { rollback(); }",
			"try {} catch (e) { const decoded = e.codex ?? e.encode; }",
			"try {} catch (e) { if (/\\.code}/.test(e.message)) y(); }",
			"p.catch(settled); const code = 1;",
			"try {} catch (e) { y(); } const { code } = info;",
			"function catcher(e) { return e.code; }",
		];
		for (const source of clean) {
			assert.deepEqual(fieldReads(source), [], source);
		}
	});

	test("code only: literals blanked, structure and template expressions kept", () => {
		assert.equal(codeOnly('a("x{y", "code")'), 'a("   ", "code")');
		assert.equal(codeOnly(`a(\`t{ \${b.code} }\`)`), `a(\`   \${b.code}  \`)`);
		assert.equal(
			codeOnly("a = /[/{]x/g; b = c / d / e;"),
			"a = /     /g; b = c / d / e;",
		);
		assert.equal(codeOnly("x; // }\ny"), "x; \ny");
	});
});
