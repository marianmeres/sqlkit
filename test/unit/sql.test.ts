// The fragment builder: one case per rule of plan doc 01 #1, the fragment cases of the
// prior implementation (tmp/prior-art/engine/test/unit/dialect.test.ts), nesting three deep
// and a 30,000-part join. Pure string assertions, no database. Imports the root entry point,
// so it also proves that loads and exports what it says.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	bind,
	EMPTY,
	ident,
	isSql,
	join,
	json,
	quoteIdent,
	quoteLiteral,
	raw,
	render,
	type Sql,
	sql,
} from "../../src/mod.ts";

/** A template chunk array as the engine hands one over, for shapes source cannot spell. */
function strings(
	cooked: (string | undefined)[],
	rawText: string[],
): TemplateStringsArray {
	return Object.assign([...cooked], {
		raw: rawText,
	}) as unknown as TemplateStringsArray;
}

describe("unit/sql: building blocks", () => {
	test("raw is text with no values; bind is one value with no text", () => {
		assert.deepEqual(raw("select 1"), {
			kind: "sql",
			chunks: ["select 1"],
			values: [],
		});
		assert.deepEqual(bind(7), { kind: "sql", chunks: ["", ""], values: [7] });
		assert.deepEqual(render(sql`select ${bind(7)}`, "pg"), {
			text: "select $1",
			params: [7],
		});
	});

	test("every builder's result is a fragment, and a fragment keeps chunks = values + 1", () => {
		const built: Sql[] = [
			sql`a = ${1}`,
			raw("x"),
			bind(null),
			join([bind(1), bind(2)]),
			ident("t"),
			json({ a: 1 }),
			EMPTY,
		];
		for (const fragment of built) {
			assert.equal(isSql(fragment), true);
			assert.equal(fragment.kind, "sql");
			assert.equal(fragment.chunks.length, fragment.values.length + 1);
		}
	});

	test("EMPTY is frozen and renders to nothing", () => {
		assert.equal(Object.isFrozen(EMPTY), true);
		assert.equal(Object.isFrozen(EMPTY.chunks), true);
		assert.equal(Object.isFrozen(EMPTY.values), true);
		assert.deepEqual(render(EMPTY, "pg"), { text: "", params: [] });
		assert.deepEqual(raw(""), EMPTY);
	});

	test("isSql answers false for what no builder made", () => {
		for (const value of [null, undefined, 0, "sql", [], {}, { kind: "sql" }]) {
			assert.equal(isSql(value), false, String(value));
		}
	});
});

describe("unit/sql: rule 1, a fragment is spliced and anything else is bound", () => {
	test("an interpolated fragment is spliced, a string is bound and never spliced", () => {
		const fragment = sql`select ${raw("*")} from t where name = ${"x'; drop table t; --"}`;
		assert.deepEqual(render(fragment, "pg"), {
			text: "select * from t where name = $1",
			params: ["x'; drop table t; --"],
		});
	});

	test("an array is bound as one value, never expanded", () => {
		const list = [1, 2, 3];
		const fragment = sql`select * from t where id = any(${list})`;
		assert.deepEqual(fragment.values, [list]);
		assert.deepEqual(render(fragment, "pg"), {
			text: "select * from t where id = any($1)",
			params: [[1, 2, 3]],
		});
		// An array of fragments is a value too: only `join` makes a list of them.
		const parts = [raw("a"), raw("b")];
		assert.deepEqual(sql`${parts}`.values, [parts]);
	});

	test("an object shaped like a fragment, as parsed JSON gives one, is bound", () => {
		const forged = JSON.parse(
			'{"kind":"sql","chunks":["1; drop table t; --"],"values":[]}',
		);
		const fragment = sql`insert into t (data) values (${forged})`;
		assert.deepEqual(render(fragment, "pg"), {
			text: "insert into t (data) values ($1)",
			params: [forged],
		});
		// A copy of a real fragment through JSON loses what marks it, the same way.
		const copy = JSON.parse(JSON.stringify(raw("drop table t")));
		assert.equal(isSql(copy), false);
		assert.deepEqual(sql`${copy}`.values, [copy]);
	});

	test("join and render refuse a look-alike rather than splice it", () => {
		const forged = { kind: "sql", chunks: ["drop table t"], values: [] } as Sql;
		assert.throws(() => join([raw("a"), forged]), TypeError);
		assert.throws(() => join([1 as unknown as Sql]), /part 0 is not a fragment/);
		assert.throws(() => render(forged, "pg"), TypeError);
	});

	test("every other kind of value is bound as is", () => {
		const date = new Date(0);
		const bytes = new Uint8Array([1, 2]);
		const values = [null, undefined, true, 0, 1n, "", date, bytes, { a: 1 }];
		const fragment = sql`${values[0]},${values[1]},${values[2]},${values[3]},${values[4]},${values[5]},${values[6]},${values[7]},${values[8]}`;
		assert.equal(fragment.values.length, values.length);
		for (const [i, value] of values.entries()) {
			assert.equal(fragment.values[i], value);
		}
	});

	test("a template chunk JavaScript could not read is a TypeError, not dropped text", () => {
		// `sql\`select '\1'\`` hands the tag an undefined chunk; the prior implementation
		// read it as "", which silently shortened the statement.
		assert.throws(
			() => sql(strings([undefined], ["select '\\1'"])),
			/chunk 0 has an invalid escape sequence: select '\\1'/,
		);
		assert.throws(
			() => sql(strings(["a = ", undefined], ["a = ", " '\\x'"]), 1),
			/chunk 1 has an invalid escape/,
		);
	});
});

describe("unit/sql: rule 2, render writes the dialect's placeholders in order", () => {
	test("$1 … $n on pg, ? on sqlite", () => {
		const fragment = sql`select * from record where tenant_id = ${"t1"} and id = ${"r1"}`;
		assert.deepEqual(render(fragment, "pg"), {
			text: "select * from record where tenant_id = $1 and id = $2",
			params: ["t1", "r1"],
		});
		assert.deepEqual(render(fragment, "sqlite"), {
			text: "select * from record where tenant_id = ? and id = ?",
			params: ["t1", "r1"],
		});
	});

	test("numbering runs past nine and the same value bound twice is two parameters", () => {
		const values = Array.from({ length: 12 }, (_, i) => i);
		const { text, params } = render(join(values.map((v) => bind(v))), "pg");
		assert.equal(text, values.map((_, i) => `$${i + 1}`).join(", "));
		assert.deepEqual(params, values);
		const twice = render(sql`${"a"} = ${"a"}`, "pg");
		assert.deepEqual(twice, { text: "$1 = $2", params: ["a", "a"] });
	});

	test("render returns a fresh params array every call", () => {
		const fragment = sql`a = ${1}`;
		const first = render(fragment, "pg");
		first.params.push(2);
		assert.deepEqual(render(fragment, "pg").params, [1]);
		assert.deepEqual(fragment.values, [1]);
	});

	test("an unknown dialect is a TypeError", () => {
		assert.throws(
			() => render(raw("select 1"), "mysql" as "pg"),
			/unknown dialect "mysql"/,
		);
	});
});

describe("unit/sql: rule 3, ident quotes each segment and never splits", () => {
	test("one segment, a qualified name as two, the same on both dialects", () => {
		for (const dialect of ["pg", "sqlite"] as const) {
			assert.deepEqual(render(ident("job"), dialect), {
				text: '"job"',
				params: [],
			});
			assert.deepEqual(render(ident("public", "job"), dialect), {
				text: '"public"."job"',
				params: [],
			});
		}
	});

	test("an embedded double quote is doubled", () => {
		assert.equal(render(ident('we"ird'), "pg").text, '"we""ird"');
		assert.equal(render(ident('"'), "pg").text, '""""');
		assert.equal(quoteIdent("tenant_id"), '"tenant_id"');
		assert.equal(quoteIdent('we"ird'), '"we""ird"');
	});

	test("a dot is part of the name, never a separator", () => {
		assert.equal(render(ident("a.b"), "pg").text, '"a.b"');
		assert.equal(render(ident("s", "a.b"), "pg").text, '"s"."a.b"');
	});

	test("it splices as SQL text, binding nothing", () => {
		const fragment = sql`select * from ${ident("app", "job")} where ${ident("id")} = ${5}`;
		assert.deepEqual(render(fragment, "pg"), {
			text: 'select * from "app"."job" where "id" = $1',
			params: [5],
		});
	});

	test("no segment, an empty segment or a NUL character is a TypeError", () => {
		assert.throws(() => ident(), { name: "TypeError", message: /at least one name/ });
		assert.throws(() => ident(""), { name: "TypeError", message: /empty/ });
		assert.throws(() => ident("public", ""), { name: "TypeError", message: /empty/ });
		assert.throws(() => ident("a\0b"), { name: "TypeError", message: /NUL/ });
		assert.throws(() => ident(1 as unknown as string), {
			name: "TypeError",
			message: /must be a string, got number/,
		});
		assert.throws(() => quoteIdent(""), TypeError);
		assert.throws(() => quoteIdent("\0"), TypeError);
	});
});

describe("unit/sql: rule 4, json binds JSON text and null binds NULL", () => {
	test("null and undefined bind SQL NULL, not the JSON text null", () => {
		assert.deepEqual(render(sql`${json(null)}`, "pg"), {
			text: "$1",
			params: [null],
		});
		assert.deepEqual(render(sql`${json(undefined)}`, "sqlite"), {
			text: "?",
			params: [null],
		});
	});

	test("anything else binds JSON.stringify of it, as one value", () => {
		const cases: [unknown, string][] = [
			[{ a: 1, b: [true, null] }, '{"a":1,"b":[true,null]}'],
			[[1, 2, 3], "[1,2,3]"],
			["hello", '"hello"'],
			[0, "0"],
			[false, "false"],
			[new Date(0), '"1970-01-01T00:00:00.000Z"'],
			[{ toJSON: () => "custom" }, '"custom"'],
		];
		for (const [value, text] of cases) {
			const fragment = json(value);
			assert.deepEqual(fragment.values, [text]);
			assert.deepEqual(render(sql`values (${fragment})`, "pg"), {
				text: "values ($1)",
				params: [text],
			});
		}
	});

	test("a value with no JSON form is a TypeError", () => {
		assert.throws(() => json(() => 1), {
			name: "TypeError",
			message: /type function has no JSON representation/,
		});
		assert.throws(() => json(Symbol("s")), {
			name: "TypeError",
			message: /type symbol has no JSON representation/,
		});
		assert.throws(() => json({ toJSON: () => undefined }), {
			name: "TypeError",
			message: /type object has no JSON representation/,
		});
		// JSON.stringify's own refusals are TypeErrors already.
		assert.throws(() => json(1n), TypeError);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		assert.throws(() => json(cycle), TypeError);
	});
});

describe("unit/sql: rule 5, join", () => {
	test("join([]) is EMPTY itself", () => {
		assert.equal(join([]), EMPTY);
		assert.equal(join([], " and "), EMPTY);
		assert.deepEqual(render(join([]), "pg"), { text: "", params: [] });
	});

	test("join separates fragments and keeps their values in order", () => {
		const fragment = sql`where ${join([sql`a = ${1}`, sql`b = ${2}`, raw("c is null")], " and ")}`;
		assert.deepEqual(render(fragment, "pg"), {
			text: "where a = $1 and b = $2 and c is null",
			params: [1, 2],
		});
		assert.deepEqual(render(join([bind(1), bind(2)]), "sqlite"), {
			text: "?, ?",
			params: [1, 2],
		});
	});

	test("join builds what folding the pairwise merge builds, for every shape of part", () => {
		// The quadratic reference: one merge per separator and per part, each copying
		// everything accumulated so far. Correct, and what `join` must equal.
		const merge = (a: Sql, b: Sql): Sql => ({
			kind: "sql",
			chunks: [
				...a.chunks.slice(0, -1),
				(a.chunks[a.chunks.length - 1] ?? "") + (b.chunks[0] ?? ""),
				...b.chunks.slice(1),
			],
			values: [...a.values, ...b.values],
		});
		const naiveJoin = (parts: readonly Sql[], separator = ", "): Sql => {
			let out: Sql | undefined;
			for (const part of parts) {
				out = out === undefined ? part : merge(merge(out, raw(separator)), part);
			}
			return out ?? EMPTY;
		};
		const shapes: readonly (readonly Sql[])[] = [
			[],
			[bind(1)],
			[raw("a")],
			[raw(""), raw("")],
			[bind(1), bind(2), bind(3)],
			[sql`a = ${1}`, sql`b = ${2}`, raw("c is null")],
			[sql`${1}${2}`, raw(""), sql`x ${sql`(${3}, ${4})`} y`, bind(null)],
			[EMPTY, sql`lead ${"v"}`, EMPTY],
		];
		for (const separator of [", ", " OR ", "", " "]) {
			for (const parts of shapes) {
				const fragment = join(parts, separator);
				assert.deepEqual(fragment, naiveJoin(parts, separator));
				assert.equal(fragment.chunks.length, fragment.values.length + 1);
			}
		}
	});

	test("join is linear: a 30,000-part join in well under a second", () => {
		const n = 30_000;
		const values = Array.from({ length: n }, (_, i) => i);
		const started = performance.now();
		const fragment = join(values.map((value) => bind(value)));
		const elapsed = performance.now() - started;
		assert.deepEqual(fragment, {
			kind: "sql",
			chunks: ["", ...Array.from({ length: n - 1 }, () => ", "), ""],
			values,
		});
		const { text, params } = render(sql`x in (${fragment})`, "pg");
		assert.equal(text, `x in (${values.map((_, i) => `$${i + 1}`).join(", ")})`);
		assert.equal(params.length, n);
		assert.equal(params[n - 1], n - 1);
		assert.ok(elapsed < 1_000, `join of ${n} parts took ${elapsed.toFixed(0)} ms`);
	});

	test("a part holding more values than a spread call can take joins and renders", () => {
		// `push(...part.values)` throws RangeError well below this many arguments.
		const n = 500_000;
		const big = join(Array.from({ length: n }, (_, i) => bind(i)));
		const fragment = join([sql`a = ${"x"}`, big, bind("last")]);
		assert.equal(fragment.values.length, n + 2);
		assert.equal(fragment.values[1], 0);
		assert.equal(fragment.values[n + 1], "last");
		const { params } = render(fragment, "sqlite");
		assert.equal(params.length, n + 2);
	});
});

describe("unit/sql: nesting", () => {
	test("nesting splices text and values without renumbering", () => {
		const where = sql`tenant_id = ${"t1"} and label = ${"x"}`;
		const nested = sql`select ${raw("*")} from record where ${where} limit ${10}`;
		assert.deepEqual(render(nested, "pg"), {
			text: "select * from record where tenant_id = $1 and label = $2 limit $3",
			params: ["t1", "x", 10],
		});
	});

	test("three levels deep, values numbered in reading order on both dialects", () => {
		const level3 = sql`c = ${3} and d = ${json({ k: 4 })}`;
		const level2 = sql`b = ${2} and (${level3})`;
		const level1 = sql`a = ${1} and (${level2}) and e = ${5}`;
		const fragment = sql`select * from ${ident("s", "t")} where ${level1} limit ${6}`;
		const params = [1, 2, 3, '{"k":4}', 5, 6];
		assert.deepEqual(render(fragment, "pg"), {
			text:
				'select * from "s"."t" where a = $1 and (b = $2 and (c = $3 and d = $4))' +
				" and e = $5 limit $6",
			params,
		});
		assert.deepEqual(render(fragment, "sqlite"), {
			text:
				'select * from "s"."t" where a = ? and (b = ? and (c = ? and d = ?))' +
				" and e = ? limit ?",
			params,
		});
	});

	test("composing never changes the fragments composed", () => {
		const inner = sql`a = ${1}`;
		const before = { chunks: [...inner.chunks], values: [...inner.values] };
		sql`x ${inner} y ${inner}`;
		join([inner, inner]);
		assert.deepEqual({ chunks: inner.chunks, values: inner.values }, before);
	});
});

describe("unit/sql: quoteLiteral", () => {
	test("single quotes, an embedded single quote doubled", () => {
		assert.equal(quoteLiteral("it's"), "'it''s'");
		assert.equal(quoteLiteral(""), "''");
		assert.equal(quoteLiteral("''"), "''''''");
		assert.equal(quoteLiteral('say "hi"'), `'say "hi"'`);
	});

	test("a NUL character or a non-string is a TypeError", () => {
		assert.throws(() => quoteLiteral("a\0b"), { name: "TypeError", message: /NUL/ });
		assert.throws(() => quoteLiteral(1 as unknown as string), {
			name: "TypeError",
			message: /must be a string, got number/,
		});
	});
});
