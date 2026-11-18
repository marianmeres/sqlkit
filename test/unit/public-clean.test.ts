// Tripwire for the public-clean rule: every scoped package name of the author's that appears
// in a file git would commit is one known to be public. It catches a private package named
// in source, docs or the lockfile; it is not the whole rule, which also covers naming one in
// prose without its scope. Grow the allowlist only with packages published as public.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const SCOPE = "@marianmeres";

const PUBLIC = new Set([
	"sqlkit",
	"migrate",
	"semver",
	"item-collection",
	"pubsub",
	"searchable",
	"release",
	"steve",
	"cron",
	"kv",
	"data-to-sql-params",
	"condition-builder",
]);

/** Tracked files plus untracked ones not ignored: everything the next commit could hold. */
function committableFiles(): string[] {
	const out = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: ROOT, encoding: "utf8" },
	);
	return [...new Set(out.split("\0").filter(Boolean))];
}

function readText(path: string): string | null {
	let buf: Buffer;
	try {
		buf = readFileSync(join(ROOT, path));
	} catch {
		return null; // deleted in the working tree, still in the index
	}
	// a NUL byte in the head is the usual sign of a binary file
	if (buf.subarray(0, 8000).includes(0)) return null;
	return buf.toString("utf8");
}

test("every scoped package named in a committable file is a public one", () => {
	const files = committableFiles();
	assert.ok(files.length > 0, "git listed no files: is this a checkout?");

	const pattern = new RegExp(`${SCOPE}/([a-z0-9][a-z0-9._-]*)`, "g");
	const offenders: string[] = [];
	for (const file of files) {
		const text = readText(file);
		if (text === null) continue;
		for (const [n, line] of text.split("\n").entries()) {
			for (const m of line.matchAll(pattern)) {
				// prose may end a name with a full stop; a glob such as `name-*` leaves a dash
				const name = (m[1] ?? "").replace(/[._-]+$/, "");
				if (!PUBLIC.has(name))
					offenders.push(`${file}:${n + 1}: ${SCOPE}/${name}`);
			}
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`not on the public allowlist:\n${offenders.join("\n")}`,
	);
});
