// API.md documents every export, checked rather than reviewed: every name an entry point's
// source exports, values and types, is documented in API.md's section for that entry
// point, and every name a heading there documents is one that entry point exports.
//
// An entry point's section is the `##` heading that is its import specifier in a code
// span (`` ## `@marianmeres/sqlkit/pg` ``), up to the next `#` or `##` heading. Inside it,
// a name is documented by a code span in a heading (`` ### `createPgDriver(pool)` ``,
// several in one heading allowed) or by the code span that opens a table row
// (`` | `UniqueViolationError` | … ``); a span stands for the identifier it starts with,
// so `` `decode.bool` `` documents `decode`. Fenced code is not read.
//
// The exports are read from the source's text, comments left out, and the values are
// checked against what the module exports at runtime, so a form the reader misses fails
// rather than passes. The readers are tested on fabricated text too, so a scan that
// silently finds nothing cannot pass for a clean tree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripComments } from "./_imports.ts";
import { entryPointsOf, ROOT, readPackage } from "./_package.ts";

/** What one source file exports, by name. */
interface Exported {
	/** Functions, classes, constants: what the module has at runtime. */
	values: string[];
	/** Interfaces and type aliases, erased at runtime. */
	types: string[];
	/** An export the reader cannot name (`export *`, `export default`, an unread form). */
	problems: string[];
}

/** The names a TypeScript source exports, read from its text. */
function exportsOf(source: string): Exported {
	const code = stripComments(source);
	const values: string[] = [];
	const types: string[] = [];
	const problems: string[] = [];
	let read = 0;
	// `export { a, type B, c as d } from "…"`, `export type { … }`, `export { … }`.
	for (const m of code.matchAll(/(?<![\w$.])export\s+(type\s+)?\{([^}]*)\}/g)) {
		read++;
		for (const item of (m[2] ?? "").split(",")) {
			const text = item.trim();
			if (text === "") continue;
			const named =
				/^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
					text,
				);
			if (named === null) {
				problems.push(`cannot read the export ${JSON.stringify(text)}`);
				continue;
			}
			const name = named[3] ?? named[2] ?? "";
			(m[1] !== undefined || named[1] !== undefined ? types : values).push(name);
		}
	}
	// `export function f`, `export async function f`, `export const c`, `export class C`,
	// `export interface I`, `export type T`.
	for (const m of code.matchAll(
		/(?<![\w$.])export\s+(async\s+function\*?|function\*?|const|let|var|class|interface|type)\s+([A-Za-z_$][\w$]*)/g,
	)) {
		read++;
		const kind = m[1] ?? "";
		(kind === "interface" || kind === "type" ? types : values).push(m[2] ?? "");
	}
	// What hides its names, or names no export.
	for (const m of code.matchAll(/(?<![\w$.])export\s+(default\b|\*|=)/g)) {
		read++;
		problems.push(`export ${m[1]}: name each export instead`);
	}
	const keywords = code.match(/(?<![\w$.])export\b/g)?.length ?? 0;
	if (keywords !== read) {
		problems.push(`${keywords - read} export statement(s) the reader cannot read`);
	}
	return { values, types, problems };
}

/** The identifier each code span of `text` starts with: `` `decode.bool` `` is `decode`. */
function spanNames(text: string): string[] {
	const names: string[] = [];
	for (const m of text.matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
		const name = /^[A-Za-z_$][\w$]*/.exec((m[2] ?? "").trim())?.[0];
		if (name !== undefined) names.push(name);
	}
	return names;
}

/** One entry point's section of API.md. */
interface Section {
	/** The line of its `##` heading, 1-based. */
	readonly line: number;
	/** Every name documented in it, by a heading or by a table row. */
	readonly documented: Set<string>;
	/** The names its headings document, with their lines: each must be an export. */
	readonly headed: { name: string; line: number }[];
}

/** API.md's entry point sections, by specifier, and what is wrong with their headings. */
function sectionsOf(
	markdown: string,
	scope: string,
): { sections: Map<string, Section>; problems: string[] } {
	const sections = new Map<string, Section>();
	const problems: string[] = [];
	let current: Section | undefined;
	let fence: string | undefined;
	for (const [i, line] of markdown.split("\n").entries()) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence !== undefined) {
			if (
				marker !== undefined &&
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				line.trim() === marker
			) {
				fence = undefined;
			}
			continue;
		}
		if (marker !== undefined) {
			fence = marker;
			continue;
		}
		const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
		if (heading !== null) {
			const level = heading[1]?.length ?? 0;
			const text = heading[2] ?? "";
			if (level <= 2) {
				current = undefined;
				const specifier = /^`([^`]+)`$/.exec(text)?.[1];
				if (
					level === 2 &&
					specifier !== undefined &&
					specifier.startsWith(scope)
				) {
					if (sections.has(specifier)) {
						problems.push(
							`API.md:${i + 1}: a second section for ${specifier}`,
						);
					} else {
						current = { line: i + 1, documented: new Set(), headed: [] };
						sections.set(specifier, current);
					}
				}
			} else if (current !== undefined) {
				for (const name of spanNames(text)) {
					current.documented.add(name);
					current.headed.push({ name, line: i + 1 });
				}
			}
			continue;
		}
		if (current !== undefined) {
			const cell = /^\s*\|\s*(`+)(?!`)(.+?)(?<!`)\1(?!`)/.exec(line);
			if (cell !== null) {
				for (const name of spanNames(`\`${cell[2] ?? ""}\``))
					current.documented.add(name);
			}
		}
	}
	return { sections, problems };
}

/** What is wrong with API.md, given each entry point's exported names. */
function docProblems(
	entries: readonly { specifier: string; names: readonly string[] }[],
	markdown: string,
	scope: string,
): string[] {
	const { sections, problems } = sectionsOf(markdown, scope);
	for (const { specifier, names } of entries) {
		const section = sections.get(specifier);
		if (section === undefined) {
			problems.push(
				`${specifier}: no section (a ## heading naming it in a code span)`,
			);
			continue;
		}
		for (const name of names) {
			if (!section.documented.has(name)) {
				problems.push(`${specifier}: ${name} is exported and not documented`);
			}
		}
		for (const { name, line } of section.headed) {
			if (!names.includes(name)) {
				problems.push(
					`API.md:${line}: ${specifier}: ${name} is documented and not exported`,
				);
			}
		}
	}
	for (const [specifier, { line }] of sections) {
		if (!entries.some((entry) => entry.specifier === specifier)) {
			problems.push(`API.md:${line}: ${specifier} is not an entry point`);
		}
	}
	return problems;
}

/** Each entry point of the package, with what its source exports. */
function entryExports(): { specifier: string; source: string; exported: Exported }[] {
	return entryPointsOf(readPackage()).map(({ specifier, source }) => {
		assert.ok(source !== null, `${specifier} maps to no source (see unit/exports)`);
		const text = readFileSync(join(ROOT, source), "utf8");
		return { specifier, source, exported: exportsOf(text) };
	});
}

describe("unit/api-docs: API.md", () => {
	const scope = String(readPackage().name);

	test("every entry point's exports are read, values as the module has them at runtime", async () => {
		const entries = entryExports();
		assert.ok(entries.length >= 6, `only ${entries.length} entry points`);
		for (const { specifier, source, exported } of entries) {
			assert.deepEqual(
				exported.problems,
				[],
				`${source}: ${exported.problems.join("; ")}`,
			);
			assert.ok(
				exported.values.length + exported.types.length > 0,
				`${specifier}: no export found in ${source}`,
			);
			const module = await import(pathToFileURL(join(ROOT, source)).href);
			assert.deepEqual(
				[...exported.values].sort(),
				Object.keys(module).sort(),
				`${source}: the values read are not what the module exports`,
			);
		}
		const root = entries.find(({ specifier }) => specifier === scope);
		assert.ok(root !== undefined, `no root entry point ${scope}`);
		assert.ok(
			root.exported.types.length >= 10,
			"fewer than ten types read from the root",
		);
	});

	test("every export is documented under its entry point, and every heading names one", () => {
		const entries = entryExports().map(({ specifier, exported }) => ({
			specifier,
			names: [...exported.values, ...exported.types],
		}));
		const markdown = readFileSync(join(ROOT, "API.md"), "utf8");
		const problems = docProblems(entries, markdown, scope);
		assert.deepEqual(problems, [], `API.md problems:\n${problems.join("\n")}`);
	});
});

describe("unit/api-docs: the readers, on fabricated text", () => {
	test("exports: lists, renames, type modifiers, declarations; none from comments", () => {
		const source = [
			"/** export function fromComment() {} */",
			"// export const alsoComment = 1;",
			"export {",
			"\tand,",
			"\ttype Match,",
			"\tinner as outer,",
			'} from "./core/build.ts";',
			'export type { Row, Driver } from "./core/contract.ts";',
			"export function f() {}",
			"export async function g() {}",
			"export const C = 1;",
			"export class K {}",
			"export interface I {}",
			"export type T = string;",
			"const local = 1;",
			"export { local };",
		].join("\n");
		assert.deepEqual(exportsOf(source), {
			values: ["and", "outer", "local", "f", "g", "C", "K"],
			types: ["Match", "Row", "Driver", "I", "T"],
			problems: [],
		});
	});

	test("exports: a star, a default and an unread form are problems", () => {
		const source = [
			'export * from "./x.ts";',
			"export default 1;",
			"export enum E { A }",
			"export { a b };",
		].join("\n");
		assert.deepEqual(exportsOf(source).problems, [
			'cannot read the export "a b"',
			"export *: name each export instead",
			"export default: name each export instead",
			"1 export statement(s) the reader cannot read",
		]);
	});

	test("docs: sections, heading and table names, fences skipped, both directions checked", () => {
		const markdown = [
			"# API",
			"| `notInASection` |",
			"## `pkg`",
			"### Group",
			"#### `sql` and `` raw`x` ``",
			"#### `decode.bool`",
			"| `Thing` | a row |",
			"| --- | --- |",
			"```ts",
			"### `fenced`",
			"| `fencedRow` |",
			"```",
			"#### `stale(x)`",
			"## `pkg/sub`",
			"### `one`, `two`",
			"## `pkg/gone`",
			"## Not an entry point",
			"### `outside`",
			"## `pkg/sub`",
		].join("\n");
		const { sections, problems } = sectionsOf(markdown, "pkg");
		assert.deepEqual(problems, ["API.md:19: a second section for pkg/sub"]);
		assert.deepEqual(
			[...(sections.get("pkg")?.documented ?? [])],
			["sql", "raw", "decode", "Thing", "stale"],
		);
		assert.deepEqual(
			docProblems(
				[
					{
						specifier: "pkg",
						names: ["sql", "raw", "decode", "Thing", "missing"],
					},
					{ specifier: "pkg/sub", names: ["one", "two"] },
					{ specifier: "pkg/new", names: ["x"] },
				],
				markdown,
				"pkg",
			),
			[
				"API.md:19: a second section for pkg/sub",
				"pkg: missing is exported and not documented",
				"API.md:13: pkg: stale is documented and not exported",
				"pkg/new: no section (a ## heading naming it in a code span)",
				"API.md:16: pkg/gone is not an entry point",
			],
		);
	});
});
