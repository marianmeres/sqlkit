// The conformance bodies are runner-agnostic, checked rather than reviewed (plan doc 02 #2,
// D20): no file in `test/conformance/` other than a `*.test.ts` imports `node:test`, not
// directly and not through anything it imports. A body runs inside workerd later, where
// `node:test` does not exist; only the `*.test.ts` files that bind a body to `node:test`
// may import it.
//
// The walk follows relative imports from each file, so a helper that imports `node:test`
// cannot carry it into a body unseen. It is tested on fabricated sources as well, so a walk
// that silently finds nothing cannot pass for a clean directory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { importsOf } from "./_imports.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const CONFORMANCE = join(ROOT, "test", "conformance");

/** Every source file of `test/conformance/`, as absolute paths. */
function conformanceFiles(): string[] {
	return readdirSync(CONFORMANCE, { recursive: true })
		.map((entry) => String(entry))
		.filter((path) => /\.[cm]?[jt]s$/.test(path))
		.map((path) => join(CONFORMANCE, path))
		.sort();
}

const isTestFile = (file: string): boolean => /\.test\.[cm]?[jt]s$/.test(file);

const shown = (file: string): string => relative(ROOT, file).replaceAll(sep, "/");

/**
 * Why `file` is not runner-agnostic: each import chain from it that ends in `node:test`
 * (`a.ts → b.ts → node:test`), and each file on the way whose imports cannot be read
 * because a specifier is computed. Empty when it is clean.
 */
function offenses(file: string, read: (file: string) => string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const walk = (at: string, trail: readonly string[]): void => {
		if (seen.has(at)) return;
		seen.add(at);
		const here = [...trail, shown(at)];
		const imports = importsOf(read(at));
		if (imports.computed || imports.require) {
			found.push(`${here.join(" → ")}: an import that cannot be read`);
		}
		for (const specifier of imports.specifiers) {
			if (specifier === "node:test") {
				found.push([...here, specifier].join(" → "));
			} else if (specifier.startsWith("./") || specifier.startsWith("../")) {
				walk(resolve(dirname(at), specifier), here);
			}
		}
	};
	walk(file, []);
	return found;
}

const fromDisk = (file: string): string => readFileSync(file, "utf8");

describe("unit/conformance-imports", () => {
	test("the walk sees the harness, the registry and the bodies", () => {
		const files = conformanceFiles().map(shown);
		for (const expected of [
			"test/conformance/_suite.ts",
			"test/conformance/_adapters.ts",
			"test/conformance/driver.ts",
			"test/conformance/driver.test.ts",
			"test/conformance/sync.ts",
			"test/conformance/sync.test.ts",
		]) {
			assert.ok(files.includes(expected), `${expected} not in ${files.join(", ")}`);
		}
	});

	test("no file but a *.test.ts imports node:test, directly or through another", () => {
		const found: string[] = [];
		for (const file of conformanceFiles().filter((file) => !isTestFile(file))) {
			found.push(...offenses(file, fromDisk));
		}
		assert.deepEqual(found, []);
	});

	test("a *.test.ts does import node:test: the walk reads specifiers", () => {
		const binder = join(CONFORMANCE, "driver.test.ts");
		assert.deepEqual(offenses(binder, fromDisk), [
			"test/conformance/driver.test.ts → node:test",
		]);
	});

	test("the walk flags a direct, a transitive and an unreadable import", () => {
		const at = (name: string): string => join(CONFORMANCE, name);
		const files = new Map<string, string>([
			[at("direct.ts"), 'import { test } from "node:test";'],
			[at("via-helper.ts"), 'import { gate } from "./_helper.ts";'],
			[at("_helper.ts"), 'export { describe as gate } from "node:test";'],
			[at("lazy.ts"), 'const runner = await import("node:test");'],
			[at("computed.ts"), "const runner = await import(name);"],
			[at("cycle-a.ts"), 'import "./cycle-b.ts";'],
			[at("cycle-b.ts"), 'import "./cycle-a.ts";\nimport "node:test";'],
		]);
		const read = (file: string): string => {
			const source = files.get(file);
			assert.ok(source !== undefined, `the walk read an unknown file ${file}`);
			return source;
		};
		const dir = "test/conformance";
		assert.deepEqual(offenses(at("direct.ts"), read), [
			`${dir}/direct.ts → node:test`,
		]);
		assert.deepEqual(offenses(at("via-helper.ts"), read), [
			`${dir}/via-helper.ts → ${dir}/_helper.ts → node:test`,
		]);
		assert.deepEqual(offenses(at("lazy.ts"), read), [`${dir}/lazy.ts → node:test`]);
		assert.deepEqual(offenses(at("computed.ts"), read), [
			`${dir}/computed.ts: an import that cannot be read`,
		]);
		assert.deepEqual(offenses(at("cycle-a.ts"), read), [
			`${dir}/cycle-a.ts → ${dir}/cycle-b.ts → node:test`,
		]);
	});

	test("the walk passes what a body may import, and ignores comments", () => {
		const body = join(CONFORMANCE, "body.ts");
		const suite = join(CONFORMANCE, "_suite.ts");
		const files = new Map<string, string>([
			[
				body,
				[
					'import assert from "node:assert/strict";',
					'import type { Suite } from "./_suite.ts";',
					'// import { test } from "node:test";',
					'/** import { describe } from "node:test"; */',
				].join("\n"),
			],
			[suite, "export interface Suite {}"],
		]);
		const read = (file: string): string => files.get(file) ?? "";
		assert.deepEqual(offenses(body, read), []);
	});
});
