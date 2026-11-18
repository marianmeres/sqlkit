// The statement builders: a case per rule of plan doc 03 #1, each asserting the rendered
// text and parameters on both dialects. Pure string assertions, no database: executing them
// is the `builders` conformance body's. Imports the root entry point, so it also proves the
// builders are exported there.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	and,
	deleteFrom,
	EMPTY,
	ident,
	inList,
	insert,
	isSql,
	join,
	or,
	raw,
	render,
	type Sql,
	sql,
	update,
	upsert,
	whereEq,
} from "../../src/mod.ts";

/** Assert what `fragment` renders to on each dialect: its text there, and its params. */
function renders(
	fragment: Sql,
	expected: { pg: string; sqlite: string; params: unknown[] },
): void {
	assert.equal(isSql(fragment), true, "not a fragment");
	assert.deepEqual(render(fragment, "pg"), {
		text: expected.pg,
		params: expected.params,
	});
	assert.deepEqual(render(fragment, "sqlite"), {
		text: expected.sqlite,
		params: expected.params,
	});
}

/** A `TypeError` whose message matches `pattern`. */
function typeError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof TypeError && pattern.test(error.message);
}

/** A value past the types, as untyped code would pass it. */
// biome-ignore lint/suspicious/noExplicitAny: the cases call the builders as untyped code
const loose = (value: unknown): any => value;

describe("unit/build: the statements", () => {
	test("insert: one row", () => {
		renders(insert("job", { type: "email", attempts: 3 }), {
			pg: 'insert into "job" ("type", "attempts") values ($1, $2)',
			sqlite: 'insert into "job" ("type", "attempts") values (?, ?)',
			params: ["email", 3],
		});
	});

	test("insert: several rows, and returning", () => {
		renders(
			insert(
				"job",
				[
					{ id: 1, type: "a" },
					{ id: 2, type: "b" },
				],
				{ returning: "*" },
			),
			{
				pg: 'insert into "job" ("id", "type") values ($1, $2), ($3, $4) returning *',
				sqlite: 'insert into "job" ("id", "type") values (?, ?), (?, ?) returning *',
				params: [1, "a", 2, "b"],
			},
		);
		renders(insert("job", { id: 1 }, { returning: ["id", "created_at"] }), {
			pg: 'insert into "job" ("id") values ($1) returning "id", "created_at"',
			sqlite: 'insert into "job" ("id") values (?) returning "id", "created_at"',
			params: [1],
		});
	});

	test("update: a patch and a where, and returning", () => {
		renders(
			update("job", { status: "done", attempts: 4 }, { id: 7 }, { returning: "*" }),
			{
				pg: 'update "job" set "status" = $1, "attempts" = $2 where "id" = $3 returning *',
				sqlite: 'update "job" set "status" = ?, "attempts" = ? where "id" = ? returning *',
				params: ["done", 4, 7],
			},
		);
		renders(update("job", { status: "done" }, sql`attempts > ${3}`), {
			pg: 'update "job" set "status" = $1 where attempts > $2',
			sqlite: 'update "job" set "status" = ? where attempts > ?',
			params: ["done", 3],
		});
	});

	test("upsert: on conflict do update, and returning", () => {
		renders(
			upsert(
				"kv",
				{ key: "a", value: "x", hits: 1 },
				{ conflict: ["key"], returning: ["value"] },
			),
			{
				pg:
					'insert into "kv" ("key", "value", "hits") values ($1, $2, $3) on conflict ("key") ' +
					'do update set "value" = excluded."value", "hits" = excluded."hits" returning "value"',
				sqlite:
					'insert into "kv" ("key", "value", "hits") values (?, ?, ?) on conflict ("key") ' +
					'do update set "value" = excluded."value", "hits" = excluded."hits" returning "value"',
				params: ["a", "x", 1],
			},
		);
	});

	test("deleteFrom: a where, and returning", () => {
		renders(deleteFrom("job", { id: 7, tenant: "t1" }, { returning: ["id"] }), {
			pg: 'delete from "job" where "id" = $1 and "tenant" = $2 returning "id"',
			sqlite: 'delete from "job" where "id" = ? and "tenant" = ? returning "id"',
			params: [7, "t1"],
		});
	});

	test("whereEq, and, or, inList compose into a query", () => {
		const where = and(
			whereEq({ tenant: "t1", deleted_at: null }),
			or(sql`id in ${inList([1, 2, 3])}`, whereEq({ owner: "me" })),
		);
		renders(sql`select * from job where ${where}`, {
			pg:
				'select * from job where ("tenant" = $1 and "deleted_at" is null) and ' +
				'((id in ($2, $3, $4)) or ("owner" = $5))',
			sqlite:
				'select * from job where ("tenant" = ? and "deleted_at" is null) and ' +
				'((id in (?, ?, ?)) or ("owner" = ?))',
			params: ["t1", 1, 2, 3, "me"],
		});
	});

	test("a table is one quoted identifier, or a fragment spliced as it is", () => {
		renders(insert('we"ird.name', { a: 1 }), {
			pg: 'insert into "we""ird.name" ("a") values ($1)',
			sqlite: 'insert into "we""ird.name" ("a") values (?)',
			params: [1],
		});
		renders(deleteFrom(ident("app", "job"), { id: 1 }), {
			pg: 'delete from "app"."job" where "id" = $1',
			sqlite: 'delete from "app"."job" where "id" = ?',
			params: [1],
		});
		for (const table of [
			EMPTY,
			raw(" "),
			7,
			null,
			{ kind: "sql", chunks: ["t"], values: [] },
		]) {
			assert.throws(
				() => insert(loose(table), { a: 1 }),
				typeError(/^insert: the table/),
			);
		}
		assert.throws(
			() => insert("", { a: 1 }),
			typeError(/identifier cannot be empty/),
		);
	});
});

describe("unit/build: rule 1, undefined is left out, null binds NULL, a fragment is spliced", () => {
	test("an undefined key is left out of a row, a patch and a whereEq", () => {
		renders(insert("t", { a: 1, b: undefined, c: 3 }), {
			pg: 'insert into "t" ("a", "c") values ($1, $2)',
			sqlite: 'insert into "t" ("a", "c") values (?, ?)',
			params: [1, 3],
		});
		renders(update("t", { a: undefined, b: 2 }, { id: 1 }), {
			pg: 'update "t" set "b" = $1 where "id" = $2',
			sqlite: 'update "t" set "b" = ? where "id" = ?',
			params: [2, 1],
		});
		renders(whereEq({ a: undefined, b: 2 }), {
			pg: '"b" = $1',
			sqlite: '"b" = ?',
			params: [2],
		});
	});

	test("an undefined key in the match of update or deleteFrom is a TypeError", () => {
		// Left out, it would widen the write: every row of the tenant, not the one id.
		const id: number | undefined = undefined;
		assert.throws(
			() => update("t", { a: 1 }, { tenant: "x", id }),
			typeError(
				/^update: the match's "id" is undefined; left out, it would widen the write/,
			),
		);
		assert.throws(
			() => deleteFrom("t", { tenant: "x", id }),
			typeError(/^deleteFrom: the match's "id" is undefined; .*whereEq\(match\)/),
		);
		// whereEq is how dropping it is said on purpose.
		renders(deleteFrom("t", whereEq({ tenant: "x", id })), {
			pg: 'delete from "t" where "tenant" = $1',
			sqlite: 'delete from "t" where "tenant" = ?',
			params: ["x"],
		});
	});

	test("null binds NULL in a row and a patch, and reads is null in a match", () => {
		renders(insert("t", { a: null }), {
			pg: 'insert into "t" ("a") values ($1)',
			sqlite: 'insert into "t" ("a") values (?)',
			params: [null],
		});
		renders(update("t", { a: null }, { b: null }), {
			pg: 'update "t" set "a" = $1 where "b" is null',
			sqlite: 'update "t" set "a" = ? where "b" is null',
			params: [null],
		});
		renders(whereEq({ a: 1, b: null }), {
			pg: '"a" = $1 and "b" is null',
			sqlite: '"a" = ? and "b" is null',
			params: [1],
		});
	});

	test("a fragment value is spliced, its own values bound in order", () => {
		renders(
			update(
				"t",
				{ updated_at: raw("now()"), n: sql`n + ${1}` },
				{ id: 5, at: raw("current_date") },
			),
			{
				pg: 'update "t" set "updated_at" = now(), "n" = n + $1 where "id" = $2 and "at" = current_date',
				sqlite: 'update "t" set "updated_at" = now(), "n" = n + ? where "id" = ? and "at" = current_date',
				params: [1, 5],
			},
		);
		renders(insert("t", [{ a: raw("now()") }, { a: 2 }]), {
			pg: 'insert into "t" ("a") values (now()), ($1)',
			sqlite: 'insert into "t" ("a") values (now()), (?)',
			params: [2],
		});
		renders(inList([1, raw("two()")]), {
			pg: "($1, two())",
			sqlite: "(?, two())",
			params: [1],
		});
	});

	test("a value that only looks like a fragment is bound, not spliced", () => {
		const lookalike = { kind: "sql", chunks: ["1; drop table t"], values: [] };
		renders(insert("t", { a: lookalike }), {
			pg: 'insert into "t" ("a") values ($1)',
			sqlite: 'insert into "t" ("a") values (?)',
			params: [lookalike],
		});
	});
});

describe("unit/build: rule 2, nothing left to write is a TypeError", () => {
	test("an empty row, or one whose every value is undefined", () => {
		assert.throws(() => insert("t", {}), typeError(/^insert: the row 0 has nothing/));
		assert.throws(
			() => insert("t", { a: undefined }),
			typeError(/^insert: the row 0 has nothing/),
		);
		assert.throws(() => insert("t", []), typeError(/^insert: no rows/));
		assert.throws(
			() => upsert("t", {}, { conflict: ["a"] }),
			typeError(/^upsert: the row 0 has nothing/),
		);
	});

	test("an empty patch", () => {
		assert.throws(
			() => update("t", {}, { id: 1 }),
			typeError(/^update: the patch has nothing/),
		);
		assert.throws(
			() => update("t", { a: undefined }, { id: 1 }),
			typeError(/^update: the patch has nothing/),
		);
	});

	test("an empty whereEq", () => {
		assert.throws(() => whereEq({}), typeError(/^whereEq: the match has nothing/));
		assert.throws(
			() => whereEq({ a: undefined }),
			typeError(/^whereEq: the match has nothing/),
		);
	});

	test("an empty inList", () => {
		assert.throws(() => inList([]), typeError(/^inList: the list is empty/));
	});

	test("what is not an object is no row, patch or match", () => {
		for (const value of [null, 1, "a", [{ a: 1 }], raw("x")]) {
			assert.throws(
				() => whereEq(loose(value)),
				typeError(/^whereEq: the match must be/),
			);
			assert.throws(
				() => update("t", loose(value), { id: 1 }),
				typeError(/^update: the patch must be/),
			);
		}
		assert.throws(
			() => insert("t", loose(null)),
			typeError(/^insert: the row 0 must be/),
		);
		assert.throws(
			() => insert("t", loose([{ a: 1 }, null])),
			typeError(/^insert: the row 1 must be/),
		);
		assert.throws(() => inList(loose("abc")), typeError(/^inList: takes an array/));
	});
});

describe("unit/build: rule 3, a multi-row insert has one key set", () => {
	test("columns come from the first row; a later row's key order does not matter", () => {
		renders(
			insert("t", [
				{ a: 1, b: 2 },
				{ b: 4, a: 3 },
			]),
			{
				pg: 'insert into "t" ("a", "b") values ($1, $2), ($3, $4)',
				sqlite: 'insert into "t" ("a", "b") values (?, ?), (?, ?)',
				params: [1, 2, 3, 4],
			},
		);
	});

	test("a row with a different key set is a TypeError", () => {
		const differs = typeError(
			/^insert: row 1 has the keys .* where row 0 has "a", "b"/,
		);
		assert.throws(() => insert("t", [{ a: 1, b: 2 }, { a: 3 }]), differs);
		assert.throws(
			() =>
				insert("t", [
					{ a: 1, b: 2 },
					{ a: 3, c: 4 },
				]),
			differs,
		);
		assert.throws(
			() =>
				insert("t", [
					{ a: 1, b: 2 },
					{ a: 3, b: 4, c: 5 },
				]),
			differs,
		);
		// An undefined value is a key left out, so it changes the key set too.
		assert.throws(
			() =>
				insert("t", [
					{ a: 1, b: 2 },
					{ a: 3, b: undefined },
				]),
			differs,
		);
	});
});

describe("unit/build: rule 4, update and deleteFrom require a where", () => {
	test("EMPTY, a blank fragment, an empty match or none at all is a TypeError", () => {
		for (const where of [EMPTY, raw(""), raw("  "), and(), {}, { a: undefined }]) {
			assert.throws(() => update("t", { a: 1 }, where), typeError(/^update: /));
			assert.throws(() => deleteFrom("t", where), typeError(/^deleteFrom: /));
		}
		assert.throws(
			() => update("t", { a: 1 }, loose(undefined)),
			typeError(/^update: a where is required; .*raw\("true"\)/),
		);
		assert.throws(
			() => deleteFrom("t", loose(undefined)),
			typeError(/^deleteFrom: a where is required; .*raw\("true"\)/),
		);
		assert.throws(
			() => deleteFrom("t", EMPTY),
			typeError(/^deleteFrom: the where fragment is empty; .*raw\("true"\)/),
		);
		assert.throws(
			() => deleteFrom("t", loose(null)),
			typeError(/^deleteFrom: the match/),
		);
	});

	test('touching every row is spelled raw("true")', () => {
		renders(update("t", { a: 1 }, raw("true")), {
			pg: 'update "t" set "a" = $1 where true',
			sqlite: 'update "t" set "a" = ? where true',
			params: [1],
		});
		renders(deleteFrom("t", raw("true")), {
			pg: 'delete from "t" where true',
			sqlite: 'delete from "t" where true',
			params: [],
		});
	});
});

describe("unit/build: rule 5, upsert's update list", () => {
	test("defaults to every written column not in conflict", () => {
		renders(upsert("t", { a: 1, b: 2, c: 3 }, { conflict: ["a", "b"] }), {
			pg: 'insert into "t" ("a", "b", "c") values ($1, $2, $3) on conflict ("a", "b") do update set "c" = excluded."c"',
			sqlite: 'insert into "t" ("a", "b", "c") values (?, ?, ?) on conflict ("a", "b") do update set "c" = excluded."c"',
			params: [1, 2, 3],
		});
	});

	test("an explicit list overwrites just those columns", () => {
		renders(upsert("t", { a: 1, b: 2, c: 3 }, { conflict: ["a"], update: ["c"] }), {
			pg: 'insert into "t" ("a", "b", "c") values ($1, $2, $3) on conflict ("a") do update set "c" = excluded."c"',
			sqlite: 'insert into "t" ("a", "b", "c") values (?, ?, ?) on conflict ("a") do update set "c" = excluded."c"',
			params: [1, 2, 3],
		});
	});

	test("update: [] renders do nothing, and so does a default with nothing left", () => {
		renders(
			upsert("t", { a: 1, b: 2 }, { conflict: ["a"], update: [], returning: "*" }),
			{
				pg: 'insert into "t" ("a", "b") values ($1, $2) on conflict ("a") do nothing returning *',
				sqlite: 'insert into "t" ("a", "b") values (?, ?) on conflict ("a") do nothing returning *',
				params: [1, 2],
			},
		);
		renders(upsert("t", { a: 1 }, { conflict: ["a"] }), {
			pg: 'insert into "t" ("a") values ($1) on conflict ("a") do nothing',
			sqlite: 'insert into "t" ("a") values (?) on conflict ("a") do nothing',
			params: [1],
		});
	});

	test("a missing or empty conflict list, a bad update list, or several rows is a TypeError", () => {
		assert.throws(
			() => upsert("t", { a: 1 }, loose(undefined)),
			typeError(/^upsert: options with a "conflict" list are required/),
		);
		for (const conflict of [undefined, [], "a"]) {
			assert.throws(
				() => upsert("t", { a: 1 }, loose({ conflict })),
				typeError(/^upsert: "conflict" must be a non-empty array/),
			);
		}
		assert.throws(
			() => upsert("t", { a: 1, b: 2 }, loose({ conflict: ["a"], update: "b" })),
			typeError(/^upsert: "update" must be an array/),
		);
		assert.throws(
			() => upsert("t", loose([{ a: 1 }, { a: 2 }]), { conflict: ["a"] }),
			typeError(/^upsert: takes one row/),
		);
	});
});

describe("unit/build: rule 6, and and or", () => {
	test("each remaining part is parenthesized, a single one too", () => {
		renders(and(sql`a = ${1}`), { pg: "(a = $1)", sqlite: "(a = ?)", params: [1] });
		renders(or(sql`a = ${1}`, sql`b = ${2} and c = ${3}`), {
			pg: "(a = $1) or (b = $2 and c = $3)",
			sqlite: "(a = ?) or (b = ? and c = ?)",
			params: [1, 2, 3],
		});
	});

	test("empty parts are skipped", () => {
		renders(and(EMPTY, sql`a = ${1}`, raw(" "), join([]), sql`b = ${2}`), {
			pg: "(a = $1) and (b = $2)",
			sqlite: "(a = ?) and (b = ?)",
			params: [1, 2],
		});
	});

	test("with no part left they are EMPTY", () => {
		assert.equal(and(), EMPTY);
		assert.equal(or(), EMPTY);
		assert.equal(and(EMPTY, raw("")), EMPTY);
		assert.equal(or(and(), or()), EMPTY);
	});

	test("a part that is not a fragment is a TypeError", () => {
		const lookalike = { kind: "sql", chunks: ["true"], values: [] };
		assert.throws(
			() => and(loose({ a: 1 })),
			typeError(/^and: part 0 is not a fragment/),
		);
		assert.throws(
			() => or(sql`a`, loose(lookalike)),
			typeError(/^or: part 1 is not a fragment/),
		);
	});
});

describe("unit/build: rule 7, identifiers are quoted and values are bound", () => {
	test("hostile names are quoted, hostile values are parameters", () => {
		const evil = 'x"; drop table t; --';
		renders(insert(evil, { [evil]: evil }, { returning: [evil] }), {
			pg: 'insert into "x""; drop table t; --" ("x""; drop table t; --") values ($1) returning "x""; drop table t; --"',
			sqlite: 'insert into "x""; drop table t; --" ("x""; drop table t; --") values (?) returning "x""; drop table t; --"',
			params: [evil],
		});
		renders(upsert("t", { [evil]: 1, v: evil }, { conflict: [evil] }), {
			pg: 'insert into "t" ("x""; drop table t; --", "v") values ($1, $2) on conflict ("x""; drop table t; --") do update set "v" = excluded."v"',
			sqlite: 'insert into "t" ("x""; drop table t; --", "v") values (?, ?) on conflict ("x""; drop table t; --") do update set "v" = excluded."v"',
			params: [1, evil],
		});
		renders(whereEq({ [evil]: evil }), {
			pg: '"x""; drop table t; --" = $1',
			sqlite: '"x""; drop table t; --" = ?',
			params: [evil],
		});
	});

	test("every kind of value is bound as it is; the parameter rule is the adapter's", () => {
		const at = new Date(0);
		const doc = { a: [1, 2] };
		renders(insert("t", { at, doc, list: [1, 2], flag: true }), {
			pg: 'insert into "t" ("at", "doc", "list", "flag") values ($1, $2, $3, $4)',
			sqlite: 'insert into "t" ("at", "doc", "list", "flag") values (?, ?, ?, ?)',
			params: [at, doc, [1, 2], true],
		});
	});

	test("a column name that is not a string is a TypeError", () => {
		assert.throws(
			() => insert("t", { a: 1 }, loose({ returning: [1] })),
			typeError(/identifier must be a string/),
		);
		assert.throws(
			() => insert("t", { a: 1 }, loose({ returning: [] })),
			typeError(/^insert: "returning" must be a non-empty array/),
		);
		assert.throws(
			() => insert("t", { a: 1 }, loose({ returning: "id" })),
			typeError(/^insert: "returning" must be a non-empty array/),
		);
		assert.throws(
			() => upsert("t", { a: 1 }, loose({ conflict: ["a"], update: [null] })),
			typeError(/identifier must be a string/),
		);
	});
});
