// What a source file imports, read from its text: the scanner the import guards share
// (core-imports.test.ts, conformance-imports.test.ts). Each guard tests it on fabricated
// sources too, so a scan that silently finds nothing cannot pass for a clean tree.

/** What one file's code imports, comments left out. */
export interface Imports {
	/** Every literal specifier: `import … from`, `export … from`, `import "x"`, `import("x")`. */
	specifiers: string[];
	/** An `import()` whose specifier is not a string literal. */
	computed: boolean;
	/** A `require(…)` call. */
	require: boolean;
}

/**
 * Drop comments. Block comments first; a `//` is a line comment only when it is not part
 * of a `scheme://` run inside a string.
 */
export function stripComments(source: string): string {
	return source
		.replaceAll(/\/\*[\s\S]*?\*\//g, "")
		.replaceAll(/(^|[^:/])\/\/[^\n]*/g, "$1");
}

/** The imports of one file's source. */
export function importsOf(source: string): Imports {
	const code = stripComments(source);
	const specifiers: string[] = [];
	for (const pattern of [
		/(?<![\w$.])from\s*(["'])([^"'\n]*)\1/g, // import … from "x", export … from "x"
		/(?<![\w$.])import\s*(["'])([^"'\n]*)\1/g, // import "x"
		/(?<![\w$.])import\s*\(\s*(["'])([^"'\n]*)\1\s*[,)]/g, // import("x")
	]) {
		for (const match of code.matchAll(pattern)) specifiers.push(match[2] ?? "");
	}
	const dynamic = code.match(/(?<![\w$.])import\s*\(/g)?.length ?? 0;
	const literal = code.match(/(?<![\w$.])import\s*\(\s*["']/g)?.length ?? 0;
	return {
		specifiers,
		computed: dynamic > literal,
		require: /(?<![\w$.])require\s*\(/.test(code),
	};
}
