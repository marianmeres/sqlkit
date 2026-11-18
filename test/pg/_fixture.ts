// A Postgres driver on a schema of its own (plan doc 02 #4, D20): what the `pg` entry of the
// conformance registry creates for every case, and what the suites under `test/pg/` create
// with a pool size of their choosing.
//
// The schema (`sqlkit_t_<random>`) is created by a bootstrap pool of one connection,
// applied as the driver's `search_path` through the `schema` option, and dropped with
// `CASCADE` by the same bootstrap pool once the driver's own pool has ended.
//
// Imports no `node:test`: the conformance registry imports it, and the bodies it serves are
// runner-agnostic.

import { randomBytes } from "node:crypto";
import pg from "pg";
import type { Driver } from "../../src/mod.ts";
import { quoteIdent } from "../../src/mod.ts";
import { createPgDriver } from "../../src/pg/mod.ts";
import { testPgConfig } from "../_env.ts";

export interface PgFixture {
	driver: Driver;
	/** The schema the driver is bound to, for a case that asserts on it. */
	schema: string;
	dispose(): Promise<void>;
}

export interface PgFixtureOptions {
	/** The driver's pool size. The default leaves room for a few parallel transactions. */
	max?: number;
}

/** `42501 insufficient_privilege`: the one setup failure here with a one-line remedy. */
function isInsufficientPrivilege(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "42501"
	);
}

/** A fresh schema name: one per fixture, so no two cases ever share a table. */
function freshSchema(): string {
	return `sqlkit_t_${randomBytes(6).toString("hex")}`;
}

/** A driver on a schema of its own, dropped with everything in it by `dispose()`. */
export async function createPgFixture(
	options: PgFixtureOptions = {},
): Promise<PgFixture> {
	const config = testPgConfig();
	const schema = freshSchema();
	const quoted = quoteIdent(schema);
	const bootstrap = new pg.Pool({ ...config, max: 1 });
	try {
		await bootstrap.query(`create schema ${quoted}`);
	} catch (error) {
		await bootstrap.end();
		throw isInsufficientPrivilege(error)
			? new Error(
					`cannot create the per-case schema "${schema}" in ` +
						`"${config.database}": the role "${config.user}" lacks CREATE on ` +
						"the database. Grant it once, as a superuser:\n" +
						`  GRANT CREATE ON DATABASE "${config.database}" TO "${config.user}";`,
					{ cause: error },
				)
			: error;
	}
	const driver = createPgDriver(new pg.Pool({ ...config, max: options.max ?? 4 }), {
		schema,
	});
	return {
		driver,
		schema,
		async dispose(): Promise<void> {
			try {
				await driver.close();
			} finally {
				try {
					await bootstrap.query(`drop schema ${quoted} cascade`);
				} finally {
					await bootstrap.end();
				}
			}
		},
	};
}

/** A second driver on `schema`: another pool, as another process has. */
export function sameSchema(schema: string, max = 4): Driver {
	return createPgDriver(new pg.Pool({ ...testPgConfig(), max }), { schema });
}
