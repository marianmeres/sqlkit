// The docs stay true to the tree, checked rather than reviewed: every relative link in a doc
// resolves to a file or directory inside the repository, an anchor into a Markdown file
// names one of its headings, and every `src/…`, `test/…` or `docs/…` path an agent doc
// names exists. Names are compared case for case, as on the Linux CI, whatever the file
// system here does.
//
// Links are read from every doc a reader browses: the Markdown at the root and under
// `docs/`, the plan sets aside (`docs/plans/`, `docs/_archive/`). Paths are read from the
// agent docs only: there a path is a claim about this repository, where a README's example
// may name a file of the host's. A path followed by `<`, `*`, `{` or `[` is a pattern
// (`test/<adapter>/`, `test/**/*.test.ts`), not a path, and is not checked. Code is skipped
// when links are read (a link in a code sample is text) and kept when paths are read (a
// path in a code span is still a claim).
//
// The readers are tested on fabricated text too, so a scan that silently finds nothing
// cannot pass for a clean tree.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");

/** The agent docs: the entry point, its redirect, the docs it indexes, the MCP blurb. */
const AGENT_DOCS = [
	"AGENTS.md",
	"CLAUDE.md",
	"docs/architecture.md",
	"docs/conventions.md",
	"docs/tasks.md",
	"mcp-include.txt",
] as const;

/** What a check reads: a repository-relative, `/`-separated path, case for case. */
interface Tree {
	/** Whether `path` is a file or a directory; `""` is the root. */
	exists(path: string): boolean;
	isFile(path: string): boolean;
	read(path: string): string;
}

/** One thing a doc refers to, and the 1-based line it is on. */
interface Ref {
	readonly target: string;
	readonly line: number;
}

/** The text with every fenced code block's lines blanked, so line numbers still hold. */
function withoutFences(text: string): string {
	let fence: string | undefined;
	return text
		.split("\n")
		.map((line) => {
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (fence === undefined) {
				if (marker === undefined) return line;
				fence = marker;
				return "";
			}
			if (
				marker !== undefined &&
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				line.trim() === marker
			) {
				fence = undefined;
			}
			return "";
		})
		.join("\n");
}

/** The text with inline code spans blanked as well. */
function withoutCode(text: string): string {
	return withoutFences(text)
		.split("\n")
		.map((line) => line.replace(/(`+)[^`].*?\1/g, (span) => " ".repeat(span.length)))
		.join("\n");
}

/** Every link target in a Markdown text: inline links, images and reference definitions. */
function linksOf(markdown: string): Ref[] {
	const refs: Ref[] = [];
	for (const [n, line] of withoutCode(markdown).split("\n").entries()) {
		for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
			refs.push({ target: m[1] ?? "", line: n + 1 });
		}
		const definition = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line);
		if (definition !== null) refs.push({ target: definition[1] ?? "", line: n + 1 });
	}
	return refs;
}

/** A heading's anchor as GitHub writes it. */
function slugOf(heading: string): string {
	return heading
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]*>/g, "")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
		.replace(/ /g, "-");
}

/** The anchors of a Markdown text's ATX headings; a repeated one gets `-1`, `-2`, … */
function anchorsOf(markdown: string): Set<string> {
	const anchors = new Set<string>();
	const seen = new Map<string, number>();
	for (const line of withoutFences(markdown).split("\n")) {
		const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
		if (heading === undefined) continue;
		const slug = slugOf(heading);
		const count = seen.get(slug) ?? 0;
		seen.set(slug, count + 1);
		anchors.add(count === 0 ? slug : `${slug}-${count}`);
	}
	return anchors;
}

/** Every `src/…`, `test/…` or `docs/…` path a text names; patterns left out. */
function pathsOf(text: string): Ref[] {
	const refs: Ref[] = [];
	for (const [n, line] of text.split("\n").entries()) {
		for (const m of line.matchAll(/(?<![\w./@:-])(?:src|test|docs)\/[\w./-]*/g)) {
			const next = line[(m.index ?? 0) + m[0].length];
			if (next !== undefined && "<*{[".includes(next)) continue;
			refs.push({ target: m[0].replace(/\.+$/, ""), line: n + 1 });
		}
	}
	return refs;
}

/** What is wrong with the links of `doc`: one line per broken one. */
function linkProblems(doc: string, tree: Tree): string[] {
	const problems: string[] = [];
	for (const { target, line } of linksOf(tree.read(doc))) {
		const at = `${doc}:${line}: ${target}`;
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:, …
		const hash = target.indexOf("#");
		const pathPart = hash === -1 ? target : target.slice(0, hash);
		const anchor = hash === -1 ? "" : decodeURIComponent(target.slice(hash + 1));
		let path: string;
		if (pathPart === "") {
			path = doc;
		} else if (pathPart.startsWith("/")) {
			problems.push(`${at}: an absolute path, which a reader's copy does not have`);
			continue;
		} else {
			path = posix.normalize(
				posix.join(posix.dirname(doc), decodeURIComponent(pathPart)),
			);
			path = path.replace(/\/+$/, "");
			if (path === ".") path = "";
		}
		if (path === ".." || path.startsWith("../")) {
			problems.push(`${at}: outside the repository`);
		} else if (!tree.exists(path)) {
			problems.push(`${at}: no such file or directory`);
		} else if (anchor !== "" && path.endsWith(".md") && tree.isFile(path)) {
			if (!anchorsOf(tree.read(path)).has(anchor)) {
				problems.push(`${at}: no heading with that anchor`);
			}
		}
	}
	return problems;
}

/** What is wrong with the paths `doc` names: one line per missing one. */
function pathProblems(doc: string, tree: Tree): string[] {
	return pathsOf(tree.read(doc))
		.filter(({ target }) => !tree.exists(target.replace(/\/+$/, "")))
		.map(
			({ target, line }) => `${doc}:${line}: ${target}: no such file or directory`,
		);
}

/** The repository on disk, every name compared case for case. */
const disk: Tree = {
	exists(path) {
		let at = ROOT;
		for (const segment of path.split("/").filter(Boolean)) {
			let entries: string[];
			try {
				entries = readdirSync(at);
			} catch {
				return false;
			}
			if (!entries.includes(segment)) return false;
			at = join(at, segment);
		}
		return true;
	},
	isFile: (path) => statSync(join(ROOT, path)).isFile(),
	read: (path) => readFileSync(join(ROOT, path), "utf8"),
};

/** The Markdown a reader browses: the root's and `docs/`'s, the plan sets aside. */
function browsedDocs(): string[] {
	const root = readdirSync(ROOT).filter((name) => name.endsWith(".md"));
	const docs = readdirSync(join(ROOT, "docs"), { recursive: true })
		.map((entry) => `docs/${String(entry).split(sep).join("/")}`)
		.filter((path) => path.endsWith(".md"))
		.filter((path) => !/^docs\/(?:plans|_archive)\//.test(path));
	return [...root, ...docs].sort();
}

/** A fabricated tree: the files given, and every directory above them. */
function fabricated(files: Record<string, string>): Tree {
	const dirs = new Set<string>([""]);
	for (const path of Object.keys(files)) {
		let dir = path;
		while (dir.includes("/")) {
			dir = dir.slice(0, dir.lastIndexOf("/"));
			dirs.add(dir);
		}
	}
	return {
		exists: (path) => path in files || dirs.has(path),
		isFile: (path) => path in files,
		read: (path) => {
			const text = files[path];
			assert.ok(text !== undefined, `read an unknown file ${path}`);
			return text;
		},
	};
}

describe("unit/docs-links: the docs", () => {
	test("every agent doc exists and says something", () => {
		for (const doc of AGENT_DOCS) {
			assert.ok(disk.exists(doc), `${doc} is missing`);
			assert.ok(disk.read(doc).trim().length > 0, `${doc} is empty`);
		}
	});

	test("the scan sees the agent docs, their links and their paths", () => {
		const browsed = browsedDocs();
		for (const doc of AGENT_DOCS.filter((doc) => doc.endsWith(".md"))) {
			assert.ok(browsed.includes(doc), `${doc} not in ${browsed.join(", ")}`);
		}
		const links = AGENT_DOCS.flatMap((doc) => linksOf(disk.read(doc)));
		const paths = AGENT_DOCS.flatMap((doc) => pathsOf(disk.read(doc)));
		assert.ok(links.length >= 5, `only ${links.length} links found`);
		assert.ok(paths.length >= 20, `only ${paths.length} paths found`);
	});

	test("every relative link resolves, and every anchor names a heading", () => {
		const problems = browsedDocs().flatMap((doc) => linkProblems(doc, disk));
		assert.deepEqual(problems, [], `broken links:\n${problems.join("\n")}`);
	});

	test("every path an agent doc names exists", () => {
		const problems = AGENT_DOCS.flatMap((doc) => pathProblems(doc, disk));
		assert.deepEqual(problems, [], `missing paths:\n${problems.join("\n")}`);
	});
});

describe("unit/docs-links: the readers, on fabricated text", () => {
	test("links: inline, image and reference; none from code", () => {
		const markdown = [
			"See [the guide](./guide.md) and ![a figure](img/f.png).",
			'A [titled](a.md "Title") link, [two](b.md#part) on [one](c/) line.',
			"[ref]: ./ref.md",
			"`[not](code.md)` and ``[nor](code2.md)``",
			"```md",
			"[fenced](fenced.md)",
			"```",
			"- [ ] a task, not a link (really)",
		].join("\n");
		assert.deepEqual(linksOf(markdown), [
			{ target: "./guide.md", line: 1 },
			{ target: "img/f.png", line: 1 },
			{ target: "a.md", line: 2 },
			{ target: "b.md#part", line: 2 },
			{ target: "c/", line: 2 },
			{ target: "./ref.md", line: 3 },
		]);
	});

	test("anchors: GitHub's slugs, repeats numbered, fenced headings ignored", () => {
		const markdown = [
			"# sqlkit — Agent Guide",
			"## The `Driver` and R1–R11",
			"## Add an Adapter",
			"### Steps",
			"### Steps",
			"## [Linked](x.md) heading ##",
			"```",
			"## not a heading",
			"```",
		].join("\n");
		assert.deepEqual(
			[...anchorsOf(markdown)],
			[
				"sqlkit--agent-guide",
				"the-driver-and-r1r11",
				"add-an-adapter",
				"steps",
				"steps-1",
				"linked-heading",
			],
		);
	});

	test("paths: src, test and docs paths; patterns, relative imports and other words left out", () => {
		const text = [
			"Read `test/unit/sql.test.ts` and src/mod.ts.",
			"`test/<adapter>/`, `test/**/*.test.ts`, `src/{a,b}.ts`, test/[x]",
			'import { sql } from "../../src/mod.ts"; node:test, pnpm test:pg, latest/x',
			"See docs/architecture.md, then test/conformance/.",
		].join("\n");
		assert.deepEqual(pathsOf(text), [
			{ target: "test/unit/sql.test.ts", line: 1 },
			{ target: "src/mod.ts", line: 1 },
			{ target: "docs/architecture.md", line: 4 },
			{ target: "test/conformance/", line: 4 },
		]);
	});

	test("the link check flags a missing file, a missing anchor, an escape, an absolute path", () => {
		const tree = fabricated({
			"AGENTS.md": [
				"[ok](./docs/a.md) [dir](docs/) [anchor](docs/a.md#the-part)",
				"[self](#top) [web](https://example.com/x.md) [mail](mailto:a@b.c)",
				"[gone](docs/gone.md) [bad anchor](docs/a.md#nope) [no self](#nowhere)",
				"[out](../outside.md) [abs](/docs/a.md)",
				"# Top",
			].join("\n"),
			"docs/a.md": "# A\n## The Part\n[back](../AGENTS.md#top)",
		});
		assert.deepEqual(linkProblems("docs/a.md", tree), []);
		assert.deepEqual(linkProblems("AGENTS.md", tree), [
			"AGENTS.md:3: docs/gone.md: no such file or directory",
			"AGENTS.md:3: docs/a.md#nope: no heading with that anchor",
			"AGENTS.md:3: #nowhere: no heading with that anchor",
			"AGENTS.md:4: ../outside.md: outside the repository",
			"AGENTS.md:4: /docs/a.md: an absolute path, which a reader's copy does not have",
		]);
	});

	test("the path check flags a path that is not there", () => {
		const tree = fabricated({
			"AGENTS.md":
				"`src/mod.ts`, `test/unit/`, `test/unit/gone.test.ts`, `src/<x>.ts`",
			"src/mod.ts": "",
			"test/unit/a.test.ts": "",
		});
		assert.deepEqual(pathProblems("AGENTS.md", tree), [
			"AGENTS.md:1: test/unit/gone.test.ts: no such file or directory",
		]);
	});

	test("the disk tree compares names case for case", () => {
		assert.equal(disk.exists("AGENTS.md"), true);
		assert.equal(disk.exists("agents.md"), false);
		assert.equal(disk.exists("src/core/sql.ts"), true);
		assert.equal(disk.exists("src/Core/sql.ts"), false);
		assert.equal(disk.exists("src/core/nothing.ts"), false);
	});
});
