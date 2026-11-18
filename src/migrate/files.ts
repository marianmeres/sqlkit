/**
 * SQL files as versions (`./migrate/files`): every version found in a directory of plain
 * SQL files is registered on a migrate instance, its up and down workers running the
 * files' text through the driver's `exec`.
 *
 * **Node only**, and a separate entry point for that reason: a Worker has no file system.
 * The wiring itself (`./migrate`) stays runtime-neutral; this is a helper beside it.
 *
 * **Names.** A version is `<version>.up.sql`, optionally with `<version>.down.sql`, and
 * optionally labelled: `<version>__<label>.up.sql`. The version is anything semver accepts
 * (`1`, `1.2`, `v1.2.3`, `2.0.0-rc.1`; normalized, so `1` is `1.0.0`), and the label is the
 * text after the first `__`, handed to the version as its comment. An up and a down file
 * pair by version, not by label. A version with no down file is registered as
 * irreversible: `down()` and `uninstall()` refuse a path that crosses it.
 *
 * **Refusals**, all made before anything is registered, each a `TypeError` naming the file
 * (the directory, for the last):
 * a file ending in `.sql` (in any case) that does not match the pattern, an empty label, a
 * version semver rejects, a down file with no up file, two files for one version and
 * direction (`1.up.sql` and `1.0.0.up.sql` are one version, as are `1.up.sql` and
 * `01.up.sql`, which semver orders as equal), a version the instance already has, and a
 * directory with no version in it. Any other file is ignored, and subdirectories are not
 * read.
 *
 * **Each file is one `exec`**, so a file may hold several statements, and needs no splitter.
 * It runs inside the step's transaction: it must not open `BEGIN` / `COMMIT` itself, and
 * cannot hold a statement that refuses a transaction (`CREATE INDEX CONCURRENTLY`,
 * `VACUUM`). The text is read when the version is registered, a leading byte-order mark
 * dropped; a file changed afterwards is not read again.
 *
 * **One active version is stored**, not a ledger of applied steps: `up()` runs the
 * registered versions above the active one. A file added later with a version _below_ the
 * active one is therefore never applied, and never reported as pending.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	compareSemver,
	type Migrate,
	normalizeSemver,
	parseSemver,
} from "@marianmeres/migrate";
import type { MigrateContext } from "./mod.ts";

/** A name that is one version's file: `<version>[__<label>].(up|down).sql`. */
const FILE = /^(?<stem>.+)\.(?<direction>up|down)\.sql$/;

/** One file of a version, before it is read. */
interface SqlFile {
	readonly path: string;
	readonly label: string | undefined;
}

/** One version's files, found under one semver precedence. */
interface Found {
	/** The version as semver normalizes it: the up file's, once there is one. */
	version: string;
	up?: SqlFile;
	down?: SqlFile;
}

/**
 * Registers on `migrate` every version found in `dir`, from its `.up.sql` and `.down.sql`
 * files, each worker running its file through `db.exec`.
 *
 * @param migrate - The instance to register on, typically from `createMigrate`.
 * @param dir - The directory holding the files; subdirectories are not read.
 * @returns The versions registered, normalized, in semver order.
 * @throws {TypeError} (as a rejection) If an argument is not what it says, or a file is
 * refused (see the module comment); nothing is registered then.
 */
export async function addSqlFiles<TContext extends MigrateContext>(
	migrate: Migrate<TContext>,
	dir: string,
): Promise<string[]> {
	const candidate: unknown = migrate;
	// Shape, not `instanceof`: the caller's copy of the package may not be this one's.
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		typeof (candidate as { addVersion?: unknown }).addVersion !== "function" ||
		!Array.isArray((candidate as { available?: unknown }).available)
	) {
		throw new TypeError("addSqlFiles(migrate, dir) takes a Migrate instance");
	}
	if (typeof dir !== "string" || dir === "") {
		throw new TypeError("addSqlFiles(migrate, dir) takes a directory path");
	}

	const entries = await readdir(dir, { withFileTypes: true });
	// One order for every run, so a directory with two problems reports the same one.
	const names = entries
		.filter((entry) => !entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => name.toLowerCase().endsWith(".sql"))
		.sort();

	const found = new Map<string, Found>();

	for (const name of names) {
		const path = join(dir, name);
		const match = FILE.exec(name)?.groups;
		const stem = match?.stem;
		if (stem === undefined) {
			throw refusal(
				path,
				"does not match <version>[__<label>].up.sql or .down.sql",
			);
		}
		const direction = match?.direction === "down" ? "down" : "up";
		const cut = stem.indexOf("__");
		const raw = cut < 0 ? stem : stem.slice(0, cut);
		const label = cut < 0 ? undefined : stem.slice(cut + 2);
		if (label === "") throw refusal(path, "the label after __ is empty");

		const version = normalizeSemver(raw, false);
		if (version === undefined) {
			throw refusal(path, `"${raw}" is not a version semver accepts`);
		}
		const key = precedenceOf(version);
		const entry = found.get(key) ?? { version };
		const other = entry[direction];
		if (other !== undefined) {
			throw refusal(
				path,
				`a second ${direction} file for version ${entry.version}, after ${other.path}`,
			);
		}
		entry[direction] = { path, label };
		if (direction === "up") entry.version = version;
		found.set(key, entry);
	}

	const versions: { version: string; up: SqlFile; down: SqlFile | undefined }[] = [];
	for (const { version, up, down } of found.values()) {
		if (up === undefined) {
			// `found` holds an entry only for a file, so a missing up means a down is there.
			throw refusal(
				down?.path ?? dir,
				`a down file with no up file (version ${version})`,
			);
		}
		versions.push({ version, up, down });
	}
	if (versions.length === 0) {
		throw refusal(dir, "no version in it (<version>[__<label>].up.sql)");
	}
	versions.sort((a, b) => compareSemver(a.version, b.version));

	// Every file is read before the first is registered: a read that fails registers none.
	const loaded = await Promise.all(
		versions.map(async ({ version, up, down }) => ({
			version,
			label: up.label,
			upText: await read(up),
			downText: down === undefined ? undefined : await read(down),
		})),
	);

	// Checked last, with nothing awaited between the check and the first registration.
	const registered = new Map(migrate.available.map((v) => [precedenceOf(v), v]));
	for (const { version, up } of versions) {
		const existing = registered.get(precedenceOf(version));
		if (existing !== undefined) {
			throw refusal(up.path, `version ${existing} is already registered`);
		}
	}

	return loaded.map(({ version, label, upText, downText }) => {
		const upWorker = ({ db }: MigrateContext) => db.exec(upText);
		const downWorker =
			downText === undefined ? null : ({ db }: MigrateContext) => db.exec(downText);
		return migrate.addVersion(version, upWorker, downWorker, label).version;
	});
}

/** A refusal naming the file (or the directory) it is about. */
function refusal(path: string, reason: string): TypeError {
	return new TypeError(`addSqlFiles: ${path}: ${reason}`);
}

/** A file's text, without the byte-order mark an editor may have written: SQL it is not. */
async function read(file: SqlFile): Promise<string> {
	const text = await readFile(file.path, "utf8");
	return text.replace(/^\uFEFF/, "");
}

/**
 * What semver orders by, as text: two versions with equal text compare as equal, build
 * metadata and leading zeros aside, exactly as `compareSemver` reads them.
 */
function precedenceOf(version: string): string {
	const { major, minor, patch, prerelease } = parseSemver(version);
	const core = `${major}.${minor}.${patch}`;
	if (prerelease === "") return core;
	const parts = prerelease
		.split(".")
		.map((part) => (/^\d+$/.test(part) ? String(Number.parseInt(part, 10)) : part));
	return `${core}-${parts.join(".")}`;
}
