// The entry points stay true to the source, checked rather than reviewed: every target in
// `package.json`'s `exports` (and `main` and `types`) is a file the build emits from a
// source under `src/`, a subpath names its source (`"./pg"` is `src/pg/mod.ts`,
// `"./migrate/files"` is `src/migrate/files.ts`), `types` comes before the other
// conditions (TypeScript takes the first that matches), and every `src/**/mod.ts` and
// `src/migrate/files.ts` is exported. The build's mapping of `src` to `dist`
// (tsconfig.build.json) is checked too, since every target rests on it, and so is the
// manifest's `files` list, which decides what is published.
//
// The check is tested on fabricated manifests too, so a scan that finds nothing cannot
// pass for a clean package.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, test } from "node:test";
import { ROOT, readPackage, sourceOf, targetsOf } from "./_package.ts";

/** The sources that must be entry points: every `mod.ts`, and the SQL files loader. */
function isEntrySource(path: string): boolean {
	return /^src\/(?:.+\/)?mod\.ts$/.test(path) || path === "src/migrate/files.ts";
}

/** The sources a subpath may be built from: `"./x"` is `src/x/mod.ts` or `src/x.ts`. */
function sourcesFor(key: string): string[] {
	if (key === ".") return ["src/mod.ts"];
	const path = key.slice(2);
	return [`src/${path}/mod.ts`, `src/${path}.ts`];
}

/** What is wrong with a manifest's entry points, given the files under `src/`. */
function exportProblems(
	pkg: Record<string, unknown>,
	sources: readonly string[],
): string[] {
	const problems: string[] = [];
	const exports = pkg.exports;
	if (typeof exports !== "object" || exports === null || Array.isArray(exports)) {
		return ["exports: not an object of subpaths"];
	}
	const exported = new Set<string>();
	for (const [key, value] of Object.entries(exports)) {
		if (key !== "." && !/^\.\/[\w-]+(?:\/[\w-]+)*$/.test(key)) {
			problems.push(`${key}: not a subpath ("." or "./name")`);
			continue;
		}
		const found = targetsOf(value, key);
		problems.push(...found.problems);
		if (found.targets.length === 0) {
			problems.push(`${key}: no target`);
			continue;
		}
		const conditions =
			typeof value === "object" && value !== null ? Object.keys(value) : [];
		if (conditions.includes("types") && conditions[0] !== "types") {
			problems.push(`${key}: "types" is not the first condition`);
		}
		const mapped = new Set<string>();
		for (const { at, target } of found.targets) {
			const source = sourceOf(target);
			if (source === null) {
				problems.push(`${at}: ${target} is not a .js or .d.ts under ./dist/`);
			} else if (!sources.includes(source)) {
				problems.push(`${at}: ${target} has no source (${source})`);
			} else {
				mapped.add(source);
			}
		}
		if (mapped.size > 1) {
			problems.push(`${key}: its targets come from ${[...mapped].join(" and ")}`);
		}
		for (const source of mapped) {
			if (!sourcesFor(key).includes(source)) {
				problems.push(
					`${key}: built from ${source}, which the subpath does not name`,
				);
			}
			exported.add(source);
		}
	}
	for (const field of ["main", "types"]) {
		const target = pkg[field];
		if (target === undefined) continue;
		const source = typeof target === "string" ? sourceOf(target) : null;
		if (source !== "src/mod.ts") {
			problems.push(`${field}: ${String(target)} is not built from src/mod.ts`);
		}
	}
	for (const source of sources.filter(isEntrySource)) {
		if (!exported.has(source)) problems.push(`${source}: not exported`);
	}
	return problems;
}

/** Every file under `src/`, repository-relative and `/`-separated. */
function sourceFiles(): string[] {
	return readdirSync(join(ROOT, "src"), { recursive: true })
		.map((entry) => `src/${String(entry).split(sep).join("/")}`)
		.filter((path) => path.endsWith(".ts"))
		.sort();
}

/** A JSON file that may hold whole-line `//` comments, as tsconfig files do. */
function readJsonc(path: string): Record<string, unknown> {
	const text = readFileSync(join(ROOT, path), "utf8").replace(/^\s*\/\/.*$/gm, "");
	return JSON.parse(text);
}

describe("unit/exports: package.json", () => {
	test("the scan sees the entry points and the sources", () => {
		const sources = sourceFiles();
		assert.ok(
			sources.includes("src/mod.ts"),
			`src/mod.ts not in ${sources.join(", ")}`,
		);
		assert.ok(
			sources.filter(isEntrySource).length >= 6,
			"fewer than six entry sources",
		);
		const exports = readPackage().exports as Record<string, unknown>;
		assert.ok(Object.keys(exports).length >= 6, "fewer than six entry points");
	});

	test("every target maps to a source, every subpath names it, every entry source is exported", () => {
		const problems = exportProblems(readPackage(), sourceFiles());
		assert.deepEqual(problems, [], `entry point problems:\n${problems.join("\n")}`);
	});

	test("the build emits src/ to dist/, which the targets assume", () => {
		const options = readJsonc("tsconfig.build.json").compilerOptions as Record<
			string,
			unknown
		>;
		assert.equal(options.rootDir, "src");
		assert.equal(options.outDir, "dist");
	});

	test("what is published: dist and the docs, each of them there", () => {
		const files = readPackage().files;
		assert.ok(Array.isArray(files), "package.json has no files list");
		for (const doc of ["README.md", "API.md", "AGENTS.md", "CLAUDE.md", "LICENSE"]) {
			assert.ok(files.includes(doc), `${doc} is not in files`);
		}
		assert.ok(files.includes("dist"), "dist is not in files");
		for (const file of files.filter((file) => file !== "dist")) {
			assert.ok(existsSync(join(ROOT, String(file))), `${String(file)} is missing`);
		}
	});
});

describe("unit/exports: the check, on fabricated manifests", () => {
	const sources = [
		"src/mod.ts",
		"src/core/sql.ts",
		"src/pg/mod.ts",
		"src/pg/pool.ts",
		"src/migrate/mod.ts",
		"src/migrate/files.ts",
	];
	const entry = (path: string) => ({
		types: `./dist/${path}.d.ts`,
		import: `./dist/${path}.js`,
	});
	const clean = {
		main: "./dist/mod.js",
		types: "./dist/mod.d.ts",
		exports: {
			".": entry("mod"),
			"./pg": entry("pg/mod"),
			"./migrate": entry("migrate/mod"),
			"./migrate/files": entry("migrate/files"),
		},
	};

	test("a clean manifest has no problem", () => {
		assert.deepEqual(exportProblems(clean, sources), []);
	});

	test("a target outside dist, a missing source, a mismatched subpath, split targets", () => {
		const pkg = {
			exports: {
				".": "./src/mod.ts",
				"./pg": entry("pg/nothing"),
				"./sql": entry("core/sql"),
				"./migrate": {
					types: "./dist/migrate/mod.d.ts",
					import: "./dist/pg/mod.js",
				},
				"./migrate/files": {
					import: "./dist/migrate/files.js",
					types: "./dist/migrate/files.d.ts",
				},
				bad: entry("mod"),
			},
			main: "./dist/pg/mod.js",
		};
		assert.deepEqual(exportProblems(pkg, sources), [
			".: ./src/mod.ts is not a .js or .d.ts under ./dist/",
			"./pg types: ./dist/pg/nothing.d.ts has no source (src/pg/nothing.ts)",
			"./pg import: ./dist/pg/nothing.js has no source (src/pg/nothing.ts)",
			"./sql: built from src/core/sql.ts, which the subpath does not name",
			"./migrate: its targets come from src/migrate/mod.ts and src/pg/mod.ts",
			"./migrate: built from src/pg/mod.ts, which the subpath does not name",
			'./migrate/files: "types" is not the first condition',
			'bad: not a subpath ("." or "./name")',
			"main: ./dist/pg/mod.js is not built from src/mod.ts",
			"src/mod.ts: not exported",
		]);
	});

	test("an entry source left unexported, and a value that is not a target", () => {
		const pkg = {
			exports: { ".": entry("mod"), "./pg": ["./dist/pg/mod.js"] },
		};
		assert.deepEqual(exportProblems(pkg, sources), [
			"./pg: not a path or an object of conditions",
			"./pg: no target",
			"src/pg/mod.ts: not exported",
			"src/migrate/mod.ts: not exported",
			"src/migrate/files.ts: not exported",
		]);
	});

	test("sourceOf maps built files only", () => {
		assert.equal(sourceOf("./dist/mod.js"), "src/mod.ts");
		assert.equal(sourceOf("./dist/migrate/files.d.ts"), "src/migrate/files.ts");
		assert.equal(sourceOf("./dist/mod.mjs"), null);
		assert.equal(sourceOf("./src/mod.ts"), null);
		assert.equal(sourceOf("dist/mod.js"), null);
		assert.equal(sourceOf("./dist/../src/mod.js"), null);
	});
});
