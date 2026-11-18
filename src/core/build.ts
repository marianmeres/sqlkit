/**
 * Statement builders: functions that turn an object into the fragment of an `INSERT`,
 * `UPDATE`, upsert or `DELETE`, and the `WHERE` pieces those take.
 *
 * Each returns an `Sql` fragment and holds nothing: no connection, no table definition, no
 * opinion about rows. Whichever tier the caller is on executes it, async or sync, and
 * `render` writes its placeholders in the dialect's style.
 *
 *     await db.query(insert("job", { type: "email", payload }, { returning: "*" }));
 *     await db.query(update("job", { status: "done", updated_at: raw("now()") }, { id }));
 *     const ids = sql`id in ${inList([1, 2, 3])}`;
 *     await db.query(sql`select * from job where ${and(whereEq({ tenant }), ids)}`);
 *
 * The rules, the same in every builder:
 *
 * 1. A key whose value is `undefined` is left out, from a row, a patch and a match alike.
 *    `null` binds `NULL`, and in a match reads `is null`. A value that is a fragment is
 *    spliced, so `{ updated_at: raw("now()") }` writes the expression.
 * 2. Nothing left to write is a `TypeError`: an empty row, an empty patch, an empty match,
 *    an empty `inList`.
 * 3. A multi-row `insert` takes its columns from the first row; a row whose key set differs
 *    is a `TypeError`. Key order may differ.
 * 4. `update` and `deleteFrom` require a `where`. An empty fragment or an empty match is a
 *    `TypeError`; touching every row is spelled `raw("true")`.
 * 5. `upsert`'s `update` defaults to every written column not in `conflict`; with none
 *    left, or `update: []`, it renders `do nothing`.
 * 6. `and()` and `or()` skip empty parts and parenthesize each remaining one; with no parts
 *    left they are `EMPTY`.
 * 7. Every identifier goes through `ident`; every value is bound.
 *
 * A match drops an `undefined` key as a row does, which suits a filter built from optional
 * inputs, and widens it: `deleteFrom("t", { tenant, id })` with `id` undefined deletes
 * every row of the tenant. Check an input that must be there before it reaches a match.
 *
 * The statements are the subset both dialects share: `INSERT … VALUES`, `ON CONFLICT`,
 * `RETURNING`. There is no `select` builder: a query is what the `sql` tag is for.
 *
 * Runtime-neutral: imports only the fragment builder.
 */

import { bind, EMPTY, ident, isSql, join, raw, type Sql, sql } from "./sql.ts";

/** A table: a string is quoted as one identifier; `ident("app", "job")` names a schema. */
export type TableRef = string | Sql;

/** What a write hands back: every column, or the columns named. */
export type Returning = "*" | readonly string[];

/** Column names to values: a row, a patch, or the equalities of a `where`. */
export type Match = Record<string, unknown>;

/** Whether a fragment says nothing: no value, and no text but whitespace. */
function isBlank(fragment: Sql): boolean {
	return fragment.values.length === 0 && fragment.chunks.every((c) => c.trim() === "");
}

/** A value as a fragment: a fragment is spliced, anything else is bound. */
function asFragment(value: unknown): Sql {
	return isSql(value) ? value : bind(value);
}

/** The table, quoted or spliced. */
function tableOf(who: string, table: TableRef): Sql {
	if (typeof table === "string") return ident(table);
	if (isSql(table) && !isBlank(table)) return table;
	throw new TypeError(
		`${who}: the table must be a name or a non-empty fragment, got ${kindOf(table)}`,
	);
}

/** The entries of `match` that are written: every own key whose value is not `undefined`. */
function entriesOf(who: string, what: string, match: unknown): [string, unknown][] {
	if (
		typeof match !== "object" ||
		match === null ||
		Array.isArray(match) ||
		isSql(match)
	) {
		throw new TypeError(
			`${who}: the ${what} must be an object, got ${kindOf(match)}`,
		);
	}
	const entries = Object.entries(match).filter(([, value]) => value !== undefined);
	if (entries.length === 0) {
		throw new TypeError(
			`${who}: the ${what} has nothing to write: no key with a value that is not undefined`,
		);
	}
	return entries;
}

/** `"a", "b"`: a list of quoted column names, for `insert`, `on conflict` and `returning`. */
function columnList(who: string, what: string, columns: unknown): Sql {
	if (!Array.isArray(columns) || columns.length === 0) {
		throw new TypeError(
			`${who}: ${what} must be a non-empty array of column names, got ${kindOf(columns)}`,
		);
	}
	return join(columns.map((column) => ident(column as string)));
}

/** The ` returning …` tail, or nothing. */
function returningOf(who: string, options: unknown): Sql {
	if (options === undefined) return EMPTY;
	if (typeof options !== "object" || options === null) {
		throw new TypeError(`${who}: options must be an object, got ${kindOf(options)}`);
	}
	const returning = (options as { returning?: unknown }).returning;
	if (returning === undefined) return EMPTY;
	if (returning === "*") return raw(" returning *");
	return sql` returning ${columnList(who, '"returning"', returning)}`;
}

/** The condition of an `update` or a `deleteFrom`: required, and never empty. */
function whereOf(who: string, where: unknown): Sql {
	if (isSql(where)) {
		if (isBlank(where)) {
			throw new TypeError(
				`${who}: the where fragment is empty; spell touching every row raw("true")`,
			);
		}
		return where;
	}
	if (where === undefined) {
		throw new TypeError(
			`${who}: a where is required; spell touching every row raw("true")`,
		);
	}
	return equalities(who, where);
}

/** `"a" = $1 and "b" is null`. */
function equalities(who: string, match: unknown): Sql {
	const tests = entriesOf(who, "match", match).map(([column, value]) =>
		value === null
			? sql`${ident(column)} is null`
			: sql`${ident(column)} = ${asFragment(value)}`,
	);
	return join(tests, " and ");
}

/** `($1, $2)`: one row's values, in the order of `columns`. */
function tuple(values: readonly unknown[]): Sql {
	return sql`(${join(values.map(asFragment))})`;
}

/**
 * `"t" ("a", "b") values ($1, $2), ($3, $4)`: what follows `insert into`, and the columns
 * it writes.
 */
function intoValues(
	who: string,
	table: TableRef,
	rows: unknown,
): { into: Sql; columns: string[] } {
	const target = tableOf(who, table);
	const list: unknown[] = Array.isArray(rows) ? rows : [rows];
	if (list.length === 0) {
		throw new TypeError(`${who}: no rows to insert`);
	}
	const first = entriesOf(who, "row 0", list[0]);
	const columns = first.map(([column]) => column);
	const tuples: Sql[] = [tuple(first.map(([, value]) => value))];
	for (let i = 1; i < list.length; i++) {
		const row = new Map(entriesOf(who, `row ${i}`, list[i]));
		const same =
			row.size === columns.length && columns.every((column) => row.has(column));
		if (!same) {
			throw new TypeError(
				`${who}: row ${i} has the keys ${keyList([...row.keys()])}, ` +
					`where row 0 has ${keyList(columns)}`,
			);
		}
		tuples.push(tuple(columns.map((column) => row.get(column))));
	}
	const names = join(columns.map((column) => ident(column)));
	return { into: sql`${target} (${names}) values ${join(tuples)}`, columns };
}

/**
 * `insert into "t" ("a", "b") values ($1, $2), ($3, $4)`: one row, or several. A multi-row
 * insert takes its columns from the first row, and every other row must have the same keys.
 */
export function insert(
	table: TableRef,
	rows: Match | readonly Match[],
	options?: { returning?: Returning },
): Sql {
	const who = "insert";
	const { into } = intoValues(who, table, rows);
	return sql`insert into ${into}${returningOf(who, options)}`;
}

/**
 * `update "t" set "a" = $1 where …`. `where` is a fragment, or a match read as
 * {@link whereEq} reads it. It is required: touching every row is spelled `raw("true")`.
 */
export function update(
	table: TableRef,
	patch: Match,
	where: Sql | Match,
	options?: { returning?: Returning },
): Sql {
	const who = "update";
	const target = tableOf(who, table);
	const set = join(
		entriesOf(who, "patch", patch).map(
			([column, value]) => sql`${ident(column)} = ${asFragment(value)}`,
		),
	);
	const condition = whereOf(who, where);
	return sql`update ${target} set ${set} where ${condition}${returningOf(who, options)}`;
}

/**
 * `insert into "t" (…) values (…) on conflict ("id") do update set "a" = excluded."a"`.
 *
 * `conflict` names the unique columns a clash is detected on. `update` names the columns a
 * clash overwrites with the new row's values; it defaults to every written column not in
 * `conflict`. With none, or with `update: []`, a clash keeps the existing row: `do nothing`.
 */
export function upsert(
	table: TableRef,
	row: Match,
	options: {
		conflict: readonly string[];
		update?: readonly string[];
		returning?: Returning;
	},
): Sql {
	const who = "upsert";
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`${who}: options with a "conflict" list are required, got ${kindOf(options)}`,
		);
	}
	if (Array.isArray(row)) {
		throw new TypeError(`${who}: takes one row, got an array`);
	}
	const { into, columns } = intoValues(who, table, row);
	const target = columnList(who, '"conflict"', options.conflict);
	const updated: unknown =
		options.update ?? columns.filter((column) => !options.conflict.includes(column));
	if (!Array.isArray(updated)) {
		throw new TypeError(
			`${who}: "update" must be an array of column names, got ${kindOf(updated)}`,
		);
	}
	const action =
		updated.length === 0
			? raw("do nothing")
			: sql`do update set ${join(
					updated.map((column: string) => {
						const name = ident(column);
						return sql`${name} = excluded.${name}`;
					}),
				)}`;
	return sql`insert into ${into} on conflict (${target}) ${action}${returningOf(who, options)}`;
}

/**
 * `delete from "t" where …`. `where` is a fragment, or a match read as {@link whereEq}
 * reads it. It is required: deleting every row is spelled `raw("true")`.
 */
export function deleteFrom(
	table: TableRef,
	where: Sql | Match,
	options?: { returning?: Returning },
): Sql {
	const who = "deleteFrom";
	const target = tableOf(who, table);
	const condition = whereOf(who, where);
	return sql`delete from ${target} where ${condition}${returningOf(who, options)}`;
}

/**
 * `"a" = $1 and "b" is null`: one equality per key, joined by `and`. `null` reads
 * `is null`; a fragment value is spliced; an `undefined` key is left out, and a match with
 * nothing left is a `TypeError`.
 */
export function whereEq(match: Match): Sql {
	return equalities("whereEq", match);
}

/** Each part parenthesized and joined by `op`; empty parts skipped; nothing left, `EMPTY`. */
function connect(who: string, op: string, parts: readonly unknown[]): Sql {
	const kept: Sql[] = [];
	for (const [i, part] of parts.entries()) {
		if (!isSql(part)) {
			throw new TypeError(
				`${who}: part ${i} is not a fragment, got ${kindOf(part)}; use whereEq or sql`,
			);
		}
		if (!isBlank(part)) kept.push(sql`(${part})`);
	}
	return kept.length === 0 ? EMPTY : join(kept, op);
}

/** `(a) and (b)`. Empty parts are skipped; with none left, `EMPTY`. */
export function and(...parts: readonly Sql[]): Sql {
	return connect("and", " and ", parts);
}

/** `(a) or (b)`. Empty parts are skipped; with none left, `EMPTY`. */
export function or(...parts: readonly Sql[]): Sql {
	return connect("or", " or ", parts);
}

/**
 * `($1, $2, $3)`: a parenthesized list for `in`, one bound value each, a fragment spliced.
 * An empty list is a `TypeError`: `in ()` is not SQL on Postgres, and matches nothing on
 * SQLite.
 */
export function inList(values: readonly unknown[]): Sql {
	if (!Array.isArray(values)) {
		throw new TypeError(`inList: takes an array, got ${kindOf(values)}`);
	}
	if (values.length === 0) {
		throw new TypeError("inList: the list is empty");
	}
	return tuple(values);
}

/** A value's kind, for a message: never the value itself, which may be anything. */
function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (isSql(value)) return "a fragment";
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function keyList(keys: readonly string[]): string {
	return keys.length === 0
		? "(none)"
		: keys.map((key) => JSON.stringify(key)).join(", ");
}
