import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportEdits, collectCompletions, inScopeNames, resolveDefinition, unusedImportRanges } from "./completion.mjs";
import { pathToFileURL } from "node:url";

const labels = items => items.map(i => i.label);
const find = (items, label) => items.find(i => i.label === label);

test("declaration block offers reserved globals", () => {
	const doc = "@@@\nlet x = 1;\n@@@\n";
	const items = collectCompletions(doc, doc.indexOf("let x"), {});
	const names = labels(items);
	for (const reserved of ["document", "bold", "heading", "filePath", "JSON5"]) {
		assert.ok(names.includes(reserved), `expected reserved global ${reserved}`);
	}
});

test("declaration block surfaces names the document defines", () => {
	const doc = "@@@\nfunction greet() {}\nconst PI = 3.14;\n\n@@@\n";
	const items = collectCompletions(doc, doc.indexOf("const PI"), {});
	assert.equal(find(items, "greet")?.kind, "function");
	assert.equal(find(items, "PI")?.kind, "variable");
});

test("declaration block completions work before the closing fence is typed", () => {
	// No terminating @@@ yet — the cursor is still inside the open block.
	const doc = "@@@\nfunction half() {}\n";
	const items = collectCompletions(doc, doc.length, {});
	assert.ok(labels(items).includes("document"), "reserved globals still offered");
	assert.equal(find(items, "half")?.kind, "function");
});

// The cursor is written as CURSOR in these fixtures; completions are collected
// where it sits and filtered down to the parameters in scope there.
const paramsAt = doc => collectCompletions(doc, doc.indexOf("CURSOR"), {})
	.filter(i => i.detail === "parameter")
	.map(i => i.label);

test("declaration block offers the enclosing function's parameters", () => {
	assert.deepEqual(paramsAt("@@@html\nfunction center(body, width)\n{\n\tCURSOR\n}\n@@@\n"), ["body", "width"]);
});

test("destructured parameters are offered by their bound names", () => {
	assert.deepEqual(
		paramsAt("@@@html\nfunction thm({ name, body: text, level = 1, ...rest }) {\n\tCURSOR\n}\n@@@\n"),
		["name", "text", "level", "rest"],
	);
	assert.deepEqual(
		paramsAt("@@@html\nfunction f([a, , b = 2, ...tail]) {\n\tCURSOR\n}\n@@@\n"),
		["a", "b", "tail"],
	);
	assert.deepEqual(paramsAt("@@@html\nfunction f({ a: { b, c: d } }) {\n\tCURSOR\n}\n@@@\n"), ["b", "d"]);
	assert.deepEqual(paramsAt("@@@html\nfunction f({ [k]: v }) {\n\tCURSOR\n}\n@@@\n"), ["v"]);
	// A default's *value* is not a binding, even when it's a function of its own.
	assert.deepEqual(paramsAt("@@@html\nfunction f(a = fallback(z)) {\n\tCURSOR\n}\n@@@\n"), ["a"]);
	assert.deepEqual(paramsAt("@@@html\nfunction f(cb = (zz) => zz, b) {\n\tCURSOR\n}\n@@@\n"), ["cb", "b"]);
});

test("parameters are found in every function shape a declaration block uses", () => {
	assert.deepEqual(paramsAt("@@@html\n(function (q) {\n\tCURSOR\n})();\n@@@\n"), ["q"]);
	assert.deepEqual(paramsAt("@@@html\nconst g = async (m, n) => {\n\tCURSOR\n};\n@@@\n"), ["m", "n"]);
	assert.deepEqual(paramsAt("@@@html\nfunction* gen(seed) {\n\tCURSOR\n}\n@@@\n"), ["seed"]);
	assert.deepEqual(paramsAt("@@@html\nclass C { go(step) { CURSOR } }\n@@@\n"), ["step"]);
});

test("nested functions contribute their parameters too", () => {
	assert.deepEqual(
		paramsAt("@@@html\nfunction outer(a) {\n\tconst g = (b, c) => {\n\t\tCURSOR\n\t};\n}\n@@@\n"),
		["a", "b", "c"],
	);
	// A concise arrow body is a scope as well, parenthesized or not.
	assert.deepEqual(paramsAt("@@@html\nconst f = xs => xs.map(item => item.CURSOR);\n@@@\n"), ["xs", "item"]);
	assert.deepEqual(paramsAt("@@@html\nconst o = { render(node, depth) { CURSOR } };\n@@@\n"), ["node", "depth"]);
});

test("a parameter is only offered inside its own function", () => {
	assert.deepEqual(paramsAt("@@@html\nfunction one(alpha) {}\nfunction two(beta) {\n\tCURSOR\n}\n@@@\n"), ["beta"]);
	assert.deepEqual(paramsAt("@@@html\nfunction f(p) {}\nCURSOR\n@@@\n"), []);
	assert.deepEqual(paramsAt("@@@html\nfunction f(p) {}\n@@@\n\nCURSOR prose"), []);
});

// `if (...) {` and friends look exactly like a call header; only the keyword
// tells them apart.
test("a control-flow condition isn't read as a parameter list", () => {
	assert.deepEqual(paramsAt("@@@html\nfunction f(p) {\n\tif (cond) {\n\t\tCURSOR\n\t}\n}\n@@@\n"), ["p"]);
	assert.deepEqual(paramsAt("@@@html\nfunction f(p) {\n\tfor (const q of qs) {\n\t\tCURSOR\n\t}\n}\n@@@\n"), ["p"]);
});

// Brace matching runs over a copy with literals blanked out, so a stray brace or
// quote in a string, comment, template or regex can't move a function's bounds.
test("braces inside literals don't derail the scope search", () => {
	assert.deepEqual(paramsAt('@@@html\nfunction f(p) {\n\tconst s = "} function g(zzz) {";\n\tCURSOR\n}\n@@@\n'), ["p"]);
	assert.deepEqual(paramsAt("@@@html\nfunction f(p) {\n\t// } function g(zzz) {\n\tCURSOR\n}\n@@@\n"), ["p"]);
	assert.deepEqual(paramsAt('@@@html\nfunction f(p) {\n\tconst r = /[{"]/g;\n\tCURSOR\n}\n@@@\n'), ["p"]);
	assert.deepEqual(paramsAt("@@@html\nfunction f(p) {\n\treturn `a } b ${ CURSOR } c`;\n}\n@@@\n"), ["p"]);
	// A template interpolation is real code, so a function declared in one counts.
	assert.deepEqual(paramsAt("@@@html\nfunction f(p) {\n\treturn `x ${ [1].map(q => CURSOR) } y`;\n}\n@@@\n"), ["p", "q"]);
});

test("a parameter shadows the reserved global it shares a name with", () => {
	const doc = "@@@html\nfunction f(document, body) {\n\tCURSOR\n}\n@@@\n";
	const items = collectCompletions(doc, doc.indexOf("CURSOR"), {});
	const documents = items.filter(i => i.label === "document");
	assert.equal(documents.length, 1, "exactly one `document` entry");
	assert.equal(documents[0].detail, "parameter", "the parameter wins");
	assert.ok(documents[0].local, "and is marked local so it sorts first");
});

test("@-call offers reserved functions and defined names, not value globals", () => {
	const doc = "@@@\nfunction greet() {}\n@@@\n\nHello @gr";
	const items = collectCompletions(doc, doc.length, {});
	const names = labels(items);
	assert.ok(names.includes("bold"), "reserved function offered");
	assert.ok(names.includes("greet"), "defined function offered");
	assert.ok(!names.includes("filePath"), "value-only globals are not call targets");
	assert.ok(!names.includes("JSON5"), "JSON5 is not a call target");
});

test("@-call reserved functions carry a parameter signature", () => {
	const items = collectCompletions("text @he", 8, {});
	assert.match(find(items, "heading")?.detail ?? "", /\(body, headingNumber\)/);
});

test("a document override shadows the reserved built-in (no duplicate)", () => {
	const doc = "@@@\nfunction bold() {}\n@@@\n\n@bo";
	const items = collectCompletions(doc, doc.length, {});
	const bolds = items.filter(i => i.label === "bold");
	assert.equal(bolds.length, 1, "exactly one `bold` entry");
	assert.equal(bolds[0].detail, "defined in document", "the document's definition wins");
});

test("@@@ and @@ do not trigger function completion", () => {
	assert.equal(collectCompletions("@@", 2, {}).length, 0, "@@ escape");
	assert.equal(collectCompletions("@@@", 3, {}).length, 0, "@@@ fence opener");
});

test("plain prose offers no completions", () => {
	assert.equal(collectCompletions("just some text", 5, {}).length, 0);
});

test("a named import resolves its bindings' kinds from the module's exports", () => {
	const dir = mkdtempSync(join(tmpdir(), "spruce-completion-"));
	try {
		writeFileSync(join(dir, "helpers.js"), [
			"export function alpha() {}",
			"export const beta = (x) => x;",
			"export const GAMMA = 42;",
			"const delta = () => {};",
			"export { delta };",
			"export default function () {}",
		].join("\n"));
		const docPath = join(dir, "doc.sp");
		const doc = '@@@\nimport { alpha, beta, GAMMA, delta } from "./helpers.js"\n@@@\n\n@a';
		const items = collectCompletions(doc, doc.length, { filePath: docPath });

		assert.equal(find(items, "alpha")?.kind, "function");
		assert.equal(find(items, "beta")?.kind, "function", "arrow const export is a function");
		assert.equal(find(items, "GAMMA")?.kind, "variable");
		assert.ok(find(items, "delta"), "re-exported binding is offered");
		assert.match(find(items, "alpha")?.detail ?? "", /imported from \.\/helpers\.js/);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("a relative import resolves against the document's own directory", () => {
	// The helper sits at the project root; the document is in a subfolder, so the
	// import has to climb out with `../`, the way the compiler resolves it.
	const root = mkdtempSync(join(tmpdir(), "spruce-completion-"));
	try {
		writeFileSync(join(root, "helpers.js"), "export function fromRoot() {}");
		mkdirSync(join(root, "posts"));
		const docPath = join(root, "posts", "doc.sp");
		const doc = '@@@\nimport { fromRoot } from "../helpers.js"\n@@@\n\n@f';
		const items = collectCompletions(doc, doc.length, { filePath: docPath, roots: [root] });
		assert.equal(find(items, "fromRoot")?.kind, "function");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("an absolute import specifier is a filesystem path", () => {
	const root = mkdtempSync(join(tmpdir(), "spruce-completion-"));
	try {
		const libPath = join(root, "lib.js");
		writeFileSync(libPath, "export function abs() {}");
		const doc = `@@@\nimport { abs } from "${libPath}"\n@@@\n\n@a`;
		const items = collectCompletions(doc, doc.length, { filePath: join(root, "doc.sp"), roots: [root] });
		assert.equal(find(items, "abs")?.kind, "function");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("an unresolvable import is ignored without throwing", () => {
	const doc = '@@@\nimport { x } from "./missing.js"\n@@@\n\n@a';
	const items = collectCompletions(doc, doc.length, { filePath: "/some/doc.sp", roots: [] });
	assert.ok(Array.isArray(items));
});

test("resolveDefinition jumps to a name defined in a declaration block", () => {
	const doc = '@@@\nfunction greet() {}\n@@@\n\nHello @greet';
	const loc = resolveDefinition(doc, doc.lastIndexOf("greet") + 2, "/doc.sp");
	assert.equal(loc.uri, pathToFileURL("/doc.sp").href);
	// The definition span points at the `greet` token on line 1 (0-based).
	assert.equal(loc.range.start.line, 1);
	assert.equal(loc.range.start.character, "function ".length);
	assert.equal(loc.range.end.character, "function greet".length);
});

test("resolveDefinition jumps to an imported name's source export", () => {
	const dir = mkdtempSync(join(tmpdir(), "spruce-def-"));
	try {
		const lib = join(dir, "lib.js");
		writeFileSync(lib, "const x = 1;\nexport function helper() {}\n");
		const docPath = join(dir, "doc.sp");
		const doc = '@@@\nimport { helper } from "./lib.js"\n@@@\n\n@helper';
		const loc = resolveDefinition(doc, doc.lastIndexOf("helper") + 1, docPath);
		assert.equal(loc.uri, pathToFileURL(lib).href);
		assert.equal(loc.range.start.line, 1); // second line of lib.js
		assert.equal(loc.range.start.character, "export function ".length);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("resolveDefinition follows an aliased import to the source name", () => {
	const dir = mkdtempSync(join(tmpdir(), "spruce-def-"));
	try {
		const lib = join(dir, "lib.js");
		writeFileSync(lib, "export const original = () => {};\n");
		const docPath = join(dir, "doc.sp");
		const doc = '@@@\nimport { original as aliased } from "./lib.js"\n@@@\n\n@aliased';
		const loc = resolveDefinition(doc, doc.lastIndexOf("aliased") + 1, docPath);
		assert.equal(loc.uri, pathToFileURL(lib).href);
		assert.equal(loc.range.start.character, "export const ".length);
		assert.equal(loc.range.end.character, "export const original".length);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("resolveDefinition falls back to the import line when the module is unreadable", () => {
	const doc = '@@@\nimport { gone } from "./missing.js"\n@@@\n\n@gone';
	const loc = resolveDefinition(doc, doc.lastIndexOf("gone") + 1, "/doc.sp");
	assert.equal(loc.uri, pathToFileURL("/doc.sp").href);
	assert.equal(loc.range.start.line, 1); // the import line in the document
});

test("resolveDefinition jumps a reserved name to the vendored stdlib", () => {
	const doc = "Hello @bold[world]";
	const loc = resolveDefinition(doc, doc.indexOf("bold") + 1, "/doc.sp");
	assert.ok(loc, "reserved name resolves");
	assert.match(loc.uri, /stdlib\.js$/);
});

test("resolveDefinition returns null off any identifier", () => {
	const doc = "Just prose, no calls.";
	assert.equal(resolveDefinition(doc, 0, "/doc.sp"), null);
});

test("auto-import respects VS Code exclude globs", () => {
	const root = mkdtempSync(join(tmpdir(), "spruce-exclude-"));
	try {
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "generated"));
		writeFileSync(join(root, "src", "keep.js"), "export function kept() {}");
		writeFileSync(join(root, "generated", "skip.js"), "export function skipped() {}");
		writeFileSync(join(root, "noisy.gen.js"), "export function noisy() {}");
		const docPath = join(root, "src", "doc.sp");
		const doc = "Hello @k";
		const opts = { filePath: docPath, roots: [root], excludes: ["**/generated", "**/*.gen.js"] };
		const items = collectCompletions(doc, doc.length, opts);
		assert.ok(find(items, "kept"), "non-excluded export is offered");
		assert.equal(find(items, "skipped"), undefined, "export in an excluded directory is hidden");
		assert.equal(find(items, "noisy"), undefined, "export in an excluded file is hidden");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("auto-import specifiers are generated relative to the document's directory", () => {
	const root = mkdtempSync(join(tmpdir(), "spruce-completion-"));
	try {
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "helper.js"), "export function gadget() {}");
		mkdirSync(join(root, "posts"));
		const docPath = join(root, "posts", "doc.sp");
		// Cursor is in @-call position, so workspace auto-imports are offered.
		const doc = "@g";
		const items = collectCompletions(doc, doc.length, { filePath: docPath, roots: [root] });
		const gadget = find(items, "gadget");
		assert.ok(gadget?.autoImport, "gadget is offered as an auto-import");
		assert.equal(gadget.autoImport.specifier, "../sub/helper.js");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("inScopeNames includes reserved names, document definitions, and imports", () => {
	const doc = '@@@\nimport { foo } from "./x.js";\nfunction bar() {}\n@@@\n';
	const names = inScopeNames(doc);
	assert.ok(names.has("heading"), "reserved stdlib name");
	assert.ok(names.has("foo"), "imported binding");
	assert.ok(names.has("bar"), "defined function");
	assert.ok(!names.has("nope"));
});

test("unusedImportRanges flags an import whose binding is never used", () => {
	const doc = '@@@\nimport { unused } from "./x.js";\n@@@\n\n# hi';
	const ranges = unusedImportRanges(doc);
	assert.equal(ranges.length, 1);
	assert.equal(doc.slice(ranges[0].start, ranges[0].end), 'import { unused } from "./x.js"');
});

test("unusedImportRanges leaves an @-call-used import alone", () => {
	const doc = '@@@\nimport { used } from "./x.js";\n@@@\n\n@used[hi]';
	assert.deepEqual(unusedImportRanges(doc), []);
});

test("unusedImportRanges ignores the binding name appearing as prose/parsed-block text", () => {
	// `debug` shows up as ordinary text inside the parsed block (a /debug/ URL), but
	// there's no `@debug` call, so the import is unused despite the textual matches.
	const doc = [
		'@@@',
		'import { debug } from "./x.js";',
		'@@@',
		'',
		'@other[[',
		'\t<a href="/debug/htmdl-docs">HTMDL Documentation</a>',
		'\t<a href="/debug/glsl-docs">GLSL Docs</a>',
		']]',
	].join("\n");
	const ranges = unusedImportRanges(doc);
	assert.equal(ranges.length, 1);
	assert.equal(doc.slice(ranges[0].start, ranges[0].end), 'import { debug } from "./x.js"');
});

test("unusedImportRanges counts an @-call use even with the name elsewhere as text", () => {
	const doc = [
		'@@@',
		'import { debug } from "./x.js";',
		'@@@',
		'',
		'@debug[[',
		'\t<a href="/debug/htmdl-docs">HTMDL Documentation</a>',
		']]',
	].join("\n");
	assert.deepEqual(unusedImportRanges(doc), []);
});

test("unusedImportRanges leaves an import used only in declaration JS alone", () => {
	const doc = '@@@\nimport { helper } from "./x.js";\nfunction wrap(x) { return helper(x); }\n@@@\n';
	assert.deepEqual(unusedImportRanges(doc), []);
});

test("unusedImportRanges dims only the unused binding when an import is partly used", () => {
	const doc = '@@@\nimport { used, dead } from "./x.js";\n@@@\n\n@used[hi]';
	const ranges = unusedImportRanges(doc);
	assert.equal(ranges.length, 1);
	assert.equal(doc.slice(ranges[0].start, ranges[0].end), "dead");
});

test("unusedImportRanges dims an aliased unused binding at its alias", () => {
	const doc = '@@@\nimport { used, orig as dead } from "./x.js";\n@@@\n\n@used[hi]';
	const ranges = unusedImportRanges(doc);
	assert.equal(ranges.length, 1);
	assert.equal(doc.slice(ranges[0].start, ranges[0].end), "dead");
});

// Apply offset-based edits (all pure inserts here) right-to-left so earlier
// offsets stay valid as we splice.
function applyEdits(text, edits) {
	let out = text;
	for (const e of [...edits].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, e.start) + e.newText + out.slice(e.end);
	}
	return out;
}

test("buildImportEdits creates a new block with no trailing blank line inside", () => {
	const doc = "# hi";
	const out = applyEdits(doc, buildImportEdits(doc, "./x.js", "foo"));
	assert.equal(out, '@@@\n\timport { foo } from "./x.js";\n@@@\n\n# hi');
});

test("buildImportEdits opens a blank line between a new import and following code", () => {
	const doc = '@@@\nconst x = 1;\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./x.js", "foo"));
	assert.equal(out, '@@@\n\timport { foo } from "./x.js";\n\nconst x = 1;\n@@@\n');
});

test("buildImportEdits keeps the single blank line when one already exists", () => {
	const doc = '@@@\nimport { a } from "./a.js";\n\nconst x = 1;\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./x.js", "foo"));
	assert.equal(
		out,
		'@@@\nimport { a } from "./a.js";\n\timport { foo } from "./x.js";\n\nconst x = 1;\n@@@\n',
	);
});

test("buildImportEdits adds no blank line when the block has no non-import statement", () => {
	const doc = '@@@\nimport { a } from "./a.js";\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./x.js", "foo"));
	assert.equal(out, '@@@\nimport { a } from "./a.js";\n\timport { foo } from "./x.js";\n@@@\n');
});

test("buildImportEdits adds no blank line when the extended import is the last line in the block, even after other code", () => {
	const doc = '@@@\nconst y = 1;\nimport { a } from "./x.js";\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./x.js", "foo"));
	assert.equal(out, '@@@\nconst y = 1;\nimport { a, foo } from "./x.js";\n@@@\n');
});

test("buildImportEdits separates an extended group from following code", () => {
	const doc = '@@@\nimport { a } from "./x.js";\nconst y = 1;\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./x.js", "foo"));
	assert.equal(out, '@@@\nimport { a, foo } from "./x.js";\n\nconst y = 1;\n@@@\n');
});

test("buildImportEdits is a no-op when the name is already imported", () => {
	const doc = '@@@\nimport { foo } from "./x.js";\n@@@\n';
	assert.deepEqual(buildImportEdits(doc, "./x.js", "foo"), []);
});

test("buildImportEdits sorts a named group alphabetically when extending it", () => {
	const doc = '@@@\nimport { foo, alpha } from "./x.js";\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./x.js", "bravo"));
	assert.equal(out, '@@@\nimport { alpha, bravo, foo } from "./x.js";\n@@@\n');
});

test("buildImportEdits inserts a new import line in sorted specifier order", () => {
	const doc = '@@@\nimport { a } from "./a.js";\nimport { z } from "./z.js";\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./m.js", "mid"));
	assert.equal(
		out,
		'@@@\nimport { a } from "./a.js";\n\timport { mid } from "./m.js";\nimport { z } from "./z.js";\n@@@\n',
	);
});

test("buildImportEdits re-sorts an out-of-order import run when adding a line", () => {
	const doc = '@@@\nimport { z } from "./z.js";\nimport { a } from "./a.js";\n@@@\n';
	const out = applyEdits(doc, buildImportEdits(doc, "./m.js", "mid"));
	assert.equal(
		out,
		'@@@\nimport { a } from "./a.js";\n\timport { mid } from "./m.js";\nimport { z } from "./z.js";\n@@@\n',
	);
});
