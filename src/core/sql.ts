/**
 * SQL fragments: a tagged template that keeps text and values apart until the last moment.
 *
 * A fragment carries its own bound values and composes: interpolating one fragment into
 * another splices both its text and its values, so nothing is ever numbered by hand and no
 * value is ever escaped into the text. Placeholders are written last, by `render`, in the
 * dialect's style (`$1 … $n` on Postgres, `?` on SQLite), which is why a fragment is
 * dialect-agnostic until then.
 *
 *     const where = sql`tenant_id = ${tenantId}`;
 *     render(sql`select * from ${ident("app", "job")} where ${where} limit ${10}`, "pg");
 *     // { text: 'select * from "app"."job" where tenant_id = $1 limit $2',
 *     //   params: [tenantId, 10] }
 *
 * Only a fragment one of these functions built is spliced. A fragment is marked with a
 * non-enumerable symbol that JSON cannot carry, so an object that merely looks like one,
 * such as a parsed request body `{ "kind": "sql", "chunks": […] }`, is a value and is
 * bound like any other. The symbol comes from `Symbol.for`, so two copies of this module
 * in one process accept each other's fragments.
 *
 * Runtime-neutral: no import at all.
 */

/**
 * A SQL fragment: literal text chunks interleaved with bound values, exactly as a tagged
 * template splits them (`chunks.length === values.length + 1`). Build one with `sql`,
 * `raw`, `bind`, `join`, `ident` or `json`; an object literal of this shape is not one.
 */
export interface Sql {
	readonly kind: "sql";
	readonly chunks: readonly string[];
	readonly values: readonly unknown[];
}

/** What marks a fragment as built here. Non-enumerable, so equality checks ignore it. */
const BRAND = Symbol.for("@marianmeres/sqlkit/sql");

function make(chunks: readonly string[], values: readonly unknown[]): Sql {
	const fragment: Sql = { kind: "sql", chunks, values };
	Object.defineProperty(fragment, BRAND, { value: true });
	return fragment;
}

/** The empty fragment, frozen; `join([])` returns it and `raw("")` has its shape. */
export const EMPTY: Sql = Object.freeze(make(Object.freeze([""]), Object.freeze([])));

/** Whether `value` is a fragment one of this module's builders made. */
export function isSql(value: unknown): value is Sql {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<symbol, unknown>)[BRAND] === true
	);
}

/** Literal SQL text with no bound values. The caller owns its safety. */
export function raw(text: string): Sql {
	return make([text], []);
}

/** One bound value on its own, for composing into a larger fragment. */
export function bind(value: unknown): Sql {
	return make(["", ""], [value]);
}

function merge(a: Sql, b: Sql): Sql {
	const aTail = a.chunks[a.chunks.length - 1] ?? "";
	const bHead = b.chunks[0] ?? "";
	return make(
		[...a.chunks.slice(0, -1), aTail + bHead, ...b.chunks.slice(1)],
		[...a.values, ...b.values],
	);
}

/** A cooked template chunk. It is `undefined` after an escape JavaScript cannot read. */
function chunk(strings: TemplateStringsArray, i: number): string {
	const text = strings[i];
	if (text === undefined) {
		throw new TypeError(
			`sql: template chunk ${i} has an invalid escape sequence: ${String(strings.raw[i])}`,
		);
	}
	return text;
}

/**
 * Tagged template for a fragment. An interpolated fragment is spliced; anything else is
 * bound as one value. An array is one value too, never expanded into a list.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
	let out = raw(chunk(strings, 0));
	for (const [i, value] of values.entries()) {
		out = merge(out, isSql(value) ? value : bind(value));
		out = merge(out, raw(chunk(strings, i + 1)));
	}
	return out;
}

/**
 * Concatenate fragments with a literal separator (`", "` by default). `join([])` is
 * `EMPTY`. Anything in `parts` that is not a fragment is a `TypeError`: wrap a value in
 * `bind` to put it in a list.
 *
 * Linear in the total size of the parts: the two arrays are built once, by pushing, rather
 * than by a `merge` per part, which copies everything accumulated so far and would make an
 * `IN (…)` list of n values cost n². The result is exactly what folding `merge` over the
 * parts gives.
 */
export function join(parts: readonly Sql[], separator = ", "): Sql {
	if (parts.length === 0) return EMPTY;
	const chunks: string[] = [];
	const values: unknown[] = [];
	// The chunk still open for text: a part's first chunk glues onto it, and its last one
	// stays open for the separator and the next part.
	let open = "";
	for (const [i, part] of parts.entries()) {
		if (!isSql(part)) {
			throw new TypeError(
				`join: part ${i} is not a fragment; wrap a value in bind()`,
			);
		}
		if (i > 0) open += separator;
		open += part.chunks[0] ?? "";
		for (let k = 1; k < part.chunks.length; k++) {
			chunks.push(open);
			open = part.chunks[k] ?? "";
		}
		// A loop rather than `push(...values)`: a spread of a long list overflows the stack.
		for (const value of part.values) values.push(value);
	}
	chunks.push(open);
	return make(chunks, values);
}

/**
 * A quoted identifier, one argument per segment: `ident("public", "job")` is
 * `"public"."job"`. A segment is never split on a dot, so `ident("a.b")` names one object
 * called `a.b`. Quoting is the same on both dialects.
 */
export function ident(...path: string[]): Sql {
	if (path.length === 0) throw new TypeError("ident: needs at least one name");
	return raw(path.map(quoteIdent).join("."));
}

/**
 * One JSON value, bound as its JSON text, which both databases read into a JSON column.
 * `null` and `undefined` bind SQL `NULL`, not the JSON `null`. A value with no JSON form
 * (a function, a symbol) is a `TypeError`, as `JSON.stringify` makes a `BigInt` or a cycle.
 */
export function json(value: unknown): Sql {
	if (value === null || value === undefined) return bind(null);
	const text: string | undefined = JSON.stringify(value);
	if (text === undefined) {
		throw new TypeError(
			`json: a value of type ${typeof value} has no JSON representation`,
		);
	}
	return bind(text);
}

/**
 * The text and parameter array a driver's query takes. Values become placeholders in
 * order: `$1 … $n` for `pg`, `?` for `sqlite`.
 */
export function render(
	fragment: Sql,
	dialect: "pg" | "sqlite",
): { text: string; params: unknown[] } {
	if (!isSql(fragment)) {
		throw new TypeError(
			"render: not a fragment built by sql, raw, bind, join, ident or json",
		);
	}
	if (dialect !== "pg" && dialect !== "sqlite") {
		throw new TypeError(`render: unknown dialect ${JSON.stringify(dialect)}`);
	}
	let text = fragment.chunks[0] ?? "";
	const params: unknown[] = [];
	for (const [i, value] of fragment.values.entries()) {
		params.push(value);
		const placeholder = dialect === "pg" ? `$${params.length}` : "?";
		text += placeholder + (fragment.chunks[i + 1] ?? "");
	}
	return { text, params };
}

/**
 * `"we""ird"`: one identifier, double quoted, an embedded double quote doubled. An empty
 * name and a NUL character are a `TypeError`: neither database can name an object so.
 */
export function quoteIdent(name: string): string {
	if (typeof name !== "string") {
		throw new TypeError(`an identifier must be a string, got ${typeof name}`);
	}
	if (name === "") throw new TypeError("an identifier cannot be empty");
	if (name.includes("\0")) {
		throw new TypeError("an identifier cannot contain a NUL character");
	}
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * `'it''s'`: a string literal for SQL text that must embed one (a DDL default, a JSON path
 * in an expression). A bound value is the right tool everywhere else. A NUL character is a
 * `TypeError`: Postgres text cannot hold one and SQLite stops reading at it.
 */
export function quoteLiteral(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`a literal must be a string, got ${typeof value}`);
	}
	if (value.includes("\0")) {
		throw new TypeError("a literal cannot contain a NUL character");
	}
	return `'${value.replaceAll("'", "''")}'`;
}
