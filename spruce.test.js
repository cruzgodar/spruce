import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { test } from "node:test";
import { compile } from "./spruce.js";
import { stdlib } from "./stdlib.js";

// Silence console.log globally so logSourceError output (used in the
// error-reporting tests, which capture it themselves via t.mock.method)
// doesn't corrupt the TAP stream during unrelated failures.
console.log = () => {};

// The html/tex stdlib ship a default `document` post-compile hook that wraps
// output in a full document shell. These tests assert on the compiled body, so
// neutralize the defaults here; the dedicated document-hook tests install and
// remove their own.
delete stdlib.html.document;
delete stdlib.tex.document;

// Stdlib snippet that defines helpers reused across tests.
const lib = `@@@html
function id(x) { return x; }
function up(x) { return x.toUpperCase(); }
function join(...args) { return args.join(","); }
function lines() { return "a\\nb"; }
function noop() {}
@@@
`;

// Most lib-prefixed inputs produce a leading "\n" in the output because the
// document chunks are: [declarationBlock, newline, paragraph]. The
// declarationBlock substitutes to "" but the chunk-separating newline survives.
const NL = "\n";


// ============================================================================
// Block-level sugar
// ============================================================================

test("block: h1 through h6", async () =>
{
	for (let i = 1; i <= 6; i++)
	{
		const hashes = "#".repeat(i);
		assert.equal(await compile(`${hashes} X`, "html"), `<h${i}>X</h${i}>`);
	}
});

test("block: heading body parses inline elements", async () =>
{
	assert.equal(
		await compile("## **bold** heading", "html"),
		"<h2><strong>bold</strong> heading</h2>",
	);
});

test("block: code block with language tag", async () =>
{
	assert.equal(
		await compile("```js\nx = 1\n```", "html"),
		"<pre><code>x = 1</code></pre>",
	);
});

test("block: display math", async () =>
{
	assert.equal(
		await compile("$$\nbody\n$$", "html"),
		"<p>$$\\begin{align*}body\\end{align*}$$</p>",
	);
});

test("block: unordered list, single item", async () =>
{
	assert.equal(await compile("- a", "html"), "<ul><li>a</li></ul>");
});

test("block: unordered list, multiple items", async () =>
{
	assert.equal(
		await compile("- a\n- b\n- c", "html"),
		"<ul><li>a</li><li>b</li><li>c</li></ul>",
	);
});

test("block: unordered list with inline elements", async () =>
{
	assert.equal(
		await compile("- *italic* item", "html"),
		"<ul><li><em>italic</em> item</li></ul>",
	);
});

test("block: ordered list with numeric starters", async () =>
{
	assert.equal(
		await compile("1. one\n2. two", "html"),
		"<ol><li>one</li><li>two</li></ol>",
	);
});

test("block: ordered list with plus starters", async () =>
{
	assert.equal(
		await compile("+  a\n+  b", "html"),
		"<ol><li>a</li><li>b</li></ol>",
	);
});

test("block: declaration block matching scope makes its definitions available", async () =>
{
	assert.equal(
		await compile(`@@@html\nfunction f() { return "R"; }\n@@@\n@f`, "html"),
		NL + "R",
	);
});

test("block: declaration block with non-matching scope is dropped", async () =>
{
	assert.equal(await compile("@@@tex\nignored body\n@@@\nplain", "html"), NL + "<p>plain</p>");
});

test("block: multi-scope declaration block, only matching scope runs", async () =>
{
	assert.equal(
		await compile(`@@@html\nfunction f() { return "html-result"; }\n@@@tex\nthis is dead code\n@@@\n@f`, "html"),
		NL + "html-result",
	);
});

test("block: declaration block alone produces empty output", async () =>
{
	assert.equal(
		await compile(`@@@html\nfunction f() { return "x"; }\n@@@`, "html"),
		"",
	);
});


// ============================================================================
// Standard library (-l / standardLibrary)
// ============================================================================

// Write a JS module to a fresh temp dir and return its absolute path. The dir is
// removed in an after-each-style cleanup the test registers itself.
function writeStandardLibrary(source)
{
	const dir = mkdtempSync(joinPath(tmpdir(), "spruce-sl-"));
	const path = joinPath(dir, "stdlib.mjs");
	writeFileSync(path, source);
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("standard library: a named export is callable in the document", async (t) =>
{
	const { path, cleanup } = writeStandardLibrary(`export function f() { return "R"; }`);
	t.after(cleanup);
	assert.equal(await compile("@f", "html", { standardLibrary: path }), "R");
});

test("standard library: overrides the built-in stdlib", async (t) =>
{
	const { path, cleanup } = writeStandardLibrary(`export function paragraph(body) { return "<P>" + body + "</P>"; }`);
	t.after(cleanup);
	assert.equal(await compile("hi", "html", { standardLibrary: path }), "<P>hi</P>");
});

test("standard library: a declaration-block import overrides it", async (t) =>
{
	const { path, cleanup } = writeStandardLibrary(`export function f() { return "from-lib"; }`);
	t.after(cleanup);

	const imported = writeStandardLibrary(`export function f() { return "from-import"; }`);
	t.after(imported.cleanup);

	assert.equal(
		await compile(`@@@html\nimport { f } from ${JSON.stringify(imported.path)};\n@@@\n@f`, "html", { standardLibrary: path }),
		"\nfrom-import",
	);
});

test("standard library: a declaration-block declaration overrides it", async (t) =>
{
	const { path, cleanup } = writeStandardLibrary(`export function f() { return "from-lib"; }`);
	t.after(cleanup);
	assert.equal(
		await compile(`@@@html\nfunction f() { return "from-decl"; }\n@@@\n@f`, "html", { standardLibrary: path }),
		"\nfrom-decl",
	);
});

test("standard library: a document hook beats the stdlib default but loses to a declaration block", async (t) =>
{
	stdlib.html.document = body => `STDLIB[${body}]`;
	t.after(() => { delete stdlib.html.document; });

	const { path, cleanup } = writeStandardLibrary(`export function document(body) { return "LIB[" + body + "]"; }`);
	t.after(cleanup);

	assert.equal(await compile("x", "html", { standardLibrary: path }), "LIB[<p>x</p>]");

	assert.equal(
		await compile(`@@@html\nfunction document(b) { return "DECL[" + b + "]"; }\n@@@\nx`, "html", { standardLibrary: path }),
		"DECL[\n<p>x</p>]",
	);
});

test("standard library: module state resets between compiles", async (t) =>
{
	const { path, cleanup } = writeStandardLibrary(`let n = 1; export function f() { return n++; }`);
	t.after(cleanup);
	assert.equal(await compile("@f @f", "html", { standardLibrary: path }), "<p>1 2</p>");
	assert.equal(await compile("@f @f", "html", { standardLibrary: path }), "<p>1 2</p>");
});

test("declaration-block imports: module state resets between compiles but is shared within one", async (t) =>
{
	const counter = writeStandardLibrary(`let n = 1; export function next() { return n++; }`);
	t.after(counter.cleanup);

	// Re-exporting through a second file checks that the reset reaches transitive
	// imports, and that both paths still see the same instance within a compile.
	const wrapper = writeStandardLibrary(`export { next } from ${JSON.stringify(counter.path)};`);
	t.after(wrapper.cleanup);

	const doc = `@@@html\nimport { next } from ${JSON.stringify(counter.path)};\nimport { next as viaWrapper } from ${JSON.stringify(wrapper.path)};\n@@@\n@next @viaWrapper`;
	assert.equal(await compile(doc, "html"), "\n<p>1 2</p>");
	assert.equal(await compile(doc, "html"), "\n<p>1 2</p>");
});

test("standard library: a missing file raises a clear error", async () =>
{
	await assert.rejects(
		compile("@f", "html", { standardLibrary: joinPath(tmpdir(), "does-not-exist-spruce.mjs") }),
		/Couldn't load the standard library/,
	);
});


// ============================================================================
// Inline sugar
// ============================================================================

test("inline: italic with *", async () =>
{
	assert.equal(await compile("*x*", "html"), "<p><em>x</em></p>");
});

test("inline: italic with _", async () =>
{
	assert.equal(await compile("_x_", "html"), "<p><em>x</em></p>");
});

test("inline: bold with **", async () =>
{
	assert.equal(await compile("**x**", "html"), "<p><strong>x</strong></p>");
});

test("inline: bold with __", async () =>
{
	assert.equal(await compile("__x__", "html"), "<p><strong>x</strong></p>");
});

test("inline: boldItalic with ***", async () =>
{
	assert.equal(await compile("***x***", "html"), "<p><strong><em>x</em></strong></p>");
});

test("inline: boldItalic with ___", async () =>
{
	assert.equal(await compile("___x___", "html"), "<p><strong><em>x</em></strong></p>");
});

test("inline: code", async () =>
{
	assert.equal(await compile("`code`", "html"), "<p><code>code</code></p>");
});

test("inline: math", async () =>
{
	assert.equal(await compile("$math$", "html"), "<p>$math$</p>");
});

test("inline: display math", async () =>
{
	assert.equal(await compile("$$disp$$", "html"), "<p>$\\displaystyle disp$</p>");
});

test("inline: link", async () =>
{
	assert.equal(await compile("[t](u)", "html"), `<p><a href="u">t</a></p>`);
});

test("inline: link text parses inline elements", async () =>
{
	assert.equal(await compile("[**t**](u)", "html"), `<p><a href="u"><strong>t</strong></a></p>`);
});

test("inline: paragraph with mixed inline forms", async () =>
{
	assert.equal(
		await compile("alpha *e* beta **b** gamma", "html"),
		"<p>alpha <em>e</em> beta <strong>b</strong> gamma</p>",
	);
});

test("inline: repeated bold", async () =>
{
	assert.equal(
		await compile("**a** **b** **c**", "html"),
		"<p><strong>a</strong> <strong>b</strong> <strong>c</strong></p>",
	);
});

test("inline: boundary case **a***b** (parser keeps trailing **b** as bold)", async () =>
{
	assert.equal(await compile("**a***b**", "html"), "<p>**a*<strong>b</strong></p>");
});


// ============================================================================
// Function calls
// ============================================================================

test("call: bare", async () =>
{
	assert.equal(await compile(lib + "@id[hi]", "html"), NL + "hi");
});

test("call: wrapped", async () =>
{
	assert.equal(await compile(lib + "(@id [hi])", "html"), NL + "hi");
});

test("call: raw passes content through verbatim", async () =>
{
	assert.equal(await compile("@{stuff}", "html"), "stuff");
});

test("call: @[...] is the identity on inline content", async () =>
{
	// Renders its content with no surrounding brackets, parsing inline sugar.
	assert.equal(await compile("@[hello *world*]", "html"), "hello <em>world</em>");
	// Works anywhere a call does — e.g. mid-paragraph.
	assert.equal(await compile("a @[*b*] c", "html"), "<p>a <em>b</em> c</p>");
	// Nested calls inside still run.
	assert.equal(await compile(lib + "@[@up[hi]]", "html"), NL + "HI");
});

// An inline block's body guards each step with ~"]<hashes>", so a ] that isn't
// the closer is escaped through to the output instead of failing the block.
test("call: an inline block body can hold a bare ] or [", async () =>
{
	assert.equal(await compile("@#[b]c]#", "html"), "b]c");
	assert.equal(await compile("@##[a]b]c]##", "html"), "a]b]c");
	assert.equal(await compile("@[a[b]", "html"), "a[b");
	// The unhashed form still ends at the first ], so the rest stays prose.
	assert.equal(await compile("@[a]b]", "html"), "<p>ab]</p>");
});

test("call: an inline block body still parses markup and nested calls", async () =>
{
	const lib = "@@@html\nfunction up(s) { return s.toUpperCase(); }\n@@@\n";
	assert.equal(await compile(lib + "@up#[a]b]#", "html"), NL + "A]B");
	assert.equal(await compile("@[see [text](url) here]", "html"), "see <a href=\"url\">text</a> here");
	assert.equal(await compile(lib + "@#[a @up#[b]c]# d]#", "html"), NL + "a B]C d");
});

test("call: @[[...]] is the identity on a parsed block", async () =>
{
	// Its content is parsed as a whole document, so prose becomes a paragraph.
	assert.equal(await compile("@[[hello *world*]]", "html"), "<p>hello <em>world</em></p>");
	// Block-level sugar (headings, etc.) is recognized inside.
	assert.equal(
		await compile("@[[# Title\n\nbody]]", "html"),
		"<h1>Title</h1>\n\n<p>body</p>",
	);
});

test("call: escaped @ becomes literal @", async () =>
{
	assert.equal(await compile("@@", "html"), "@");
});

test("call: multiple parsed-block args", async () =>
{
	assert.equal(await compile(lib + "@join[a][b][c]", "html"), NL + "a,b,c");
});

test("call: bare call followed by prose does not swallow the @text wrapper as JSON", async () =>
{
	// Prose desugars to (@text[...]); a bare call followed by prose becomes
	// `@join[a][b](@text[ then more])`. The trailing (@text[...]) must not be read
	// as a jsonBlock argument (which would feed " then more" to JSON5.parse and
	// throw). A jsonBlock forbids a leading @, so the wrapper stays prose.
	assert.equal(
		await compile(lib + "@join[a][b] then more", "html"),
		NL + "<p>a,b then more</p>",
	);
});

test("call: nested calls regression - inner result reaches outer arg", async () =>
{
	assert.equal(await compile(lib + "(@up [(@up [hi])])", "html"), NL + "HI");
});

test("call: parsed-block body tolerates an indented closing ]]", async () =>
{
	// The body captured between [[ and ]] ends with the indentation that precedes
	// the closing ]]. An html tag (a chunk that stops at the newline) leaves that
	// whitespace-only tail (no trailing newline) unconsumed, which used to make the
	// document re-match fail outright, dropping the whole block. A trailing
	// spaceOrTab* on `document` mops it up. Dedent strips no common indentation here
	// (the <br> line sits at column 0) and keeps the trailing blank line as-is.
	assert.equal(
		await compile(lib + "(@id [[<br>\n\t\t]])", "html"),
		NL + "<br>\n\t\t",
	);
});

test("call: inline parsed-block body is trimmed by default", async () =>
{
	// Leading/trailing spaces around the [ ] body are dropped so the function
	// receives just the middle.
	assert.equal(await compile(lib + "@id[  hello  ]", "html"), NL + "hello");
});

test("call: parsed-block [[ ]] body is dedented by default", async () =>
{
	// The common indentation (one tab) is stripped from the content, but the blank
	// lines around it are kept — so the surrounding newlines survive into the body.
	assert.equal(
		await compile(lib + "(@id [[\n\thello\n]])", "html"),
		NL + "\n<p>hello\n</p>",
	);
});

test("call: -w/preserve-whitespace keeps the raw body", async () =>
{
	// With the flag set, the inline body keeps its surrounding spaces.
	assert.equal(
		await compile(lib + "@id[  hello  ]", "html", { preserveWhitespace: true }),
		NL + "  hello  ",
	);
	// And a [[ ]] body keeps its leading/trailing whitespace too.
	assert.equal(
		await compile(lib + "(@id [[<br>\n\t\t]])", "html", { preserveWhitespace: true }),
		NL + "<br>\n\t\t",
	);
});

test("call: trimming only strips the outer edges, not interior whitespace", async () =>
{
	assert.equal(await compile(lib + "@id[ a  b ]", "html"), NL + "a  b");
});

test("call: [[ ]] body dedents the common indentation, keeping relative indents", async () =>
{
	// The block is indented for source-readability; the least-indented contentful
	// line (4 spaces) sets the common indent stripped from every line, so the code
	// block's content keeps only its indentation relative to that — line1 stays one
	// level in, line2 sits at the margin. A bare .trim() would instead have eaten
	// line1's leading spaces too. The blank lines around the block are kept, so the
	// body opens and closes with a newline. (A code block is used because its raw
	// content preserves the interior whitespace the dedent produced.)
	const src =
		"@id[[\n" +
		"        ```\n" +
		"        line1\n" +
		"    line2\n" +
		"        ```\n" +
		"]]";
	assert.equal(
		await compile(lib + src, "html"),
		NL + "\n<pre><code>    line1\nline2</code></pre>\n",
	);
});

test("call: functionCallChunk re-indents every output line by its own indentation", async () =>
{
	// A call alone on an indented line adds that leading indentation to *every*
	// line of its rendered output, not just the first — so multi-line results stay
	// block-aligned under the call.
	assert.equal(await compile(lib + "\t@lines", "html"), NL + "\ta\n\tb");
});

test("call: -w/preserve-whitespace skips functionCallChunk re-indentation", async () =>
{
	// With trimming disabled, the output is left verbatim: only the first line
	// carries the literal leading indentation, exactly as written.
	assert.equal(
		await compile(lib + "\t@lines", "html", { preserveWhitespace: true }),
		NL + "\ta\nb",
	);
});

test("call: sibling parsed-block args keep their own content (no id collision)", async () =>
{
	// Each [[ ... ]] is re-matched as a fresh document, so its nested paragraph
	// calls used to come back with body-relative (colliding) ids — the last
	// block's paragraphs overwrote every other block's. Each arg must render its
	// own multi-paragraph content.
	assert.equal(
		await compile(lib + "(@join [[first A\n\nsecond A]] [[first B\n\nsecond B]])", "html"),
		NL + "<p>first A</p>\n\n<p>second A</p>,<p>first B</p>\n\n<p>second B</p>",
	);
});

test("call: function call inside a heading body", async () =>
{
	assert.equal(await compile(lib + "# @up[hello]", "html"), NL + "<h1>HELLO</h1>");
});

test("call: function call inside a bold span", async () =>
{
	assert.equal(await compile(lib + "**@up[hi]**", "html"), NL + "<p><strong>HI</strong></p>");
});

test("call: function call inside a list item", async () =>
{
	assert.equal(
		await compile(lib + "- @up[a]\n- @up[b]", "html"),
		NL + "<ul><li>A</li><li>B</li></ul>",
	);
});

test("call: function call inside a raw block @{...}", async () =>
{
	assert.equal(await compile(lib + "@{ @up[hi] }", "html"), NL + " HI ");
});

test("call: function returning undefined substitutes empty (Array.join skips it)", async () =>
{
	assert.equal(await compile(lib + "@noop", "html"), NL);
});

test("call: template-hostile arg, backtick triggers inline-code parse", async () =>
{
	assert.equal(await compile(lib + "@id[a`b`c]", "html"), NL + "a<code>b</code>c");
});

test("call: template-hostile arg, $ triggers inline math", async () =>
{
	assert.equal(await compile(lib + "@id[a$b$c]", "html"), NL + "a$b$c");
});

test("call: template-hostile arg, literal backtick in raw block (regression)", async () =>
{
	// Without escapeForTemplate turning ` into \`, the surrounding `…` wrapping
	// in the generated template literal terminates early and the JS fails to
	// parse, causing compile() to reject.
	assert.equal(await compile(lib + "@id{`}", "html"), NL + "`");
});


// ============================================================================
// JSON-block arguments ( ... )
// ============================================================================

// Reflects each argument's runtime type/value back out so the assertions can
// distinguish a real number/array/object from the usual string arguments.
const jsonLib = `@@@html
function typeOf(x) { return Array.isArray(x) ? "array" : typeof x; }
function show(x) { return JSON.stringify(x); }
function addOne(n) { return String(n + 1); }
function key(obj, k) { return String(obj[k]); }
function up(s) { return s.toUpperCase(); }
function quoted(s) { return JSON.stringify(s); }
function typeOfA(o) { return typeof o.a; }
@@@
`;

test("json: scalar argument is parsed, not a string", async () =>
{
	assert.equal(await compile(jsonLib + "@typeOf(42)", "html"), NL + "number");
	assert.equal(await compile(jsonLib + "@typeOf(true)", "html"), NL + "boolean");
	assert.equal(await compile(jsonLib + "@typeOf(null)", "html"), NL + "object");
});

test("json: number argument is usable as a number", async () =>
{
	assert.equal(await compile(jsonLib + "@addOne(41)", "html"), NL + "42");
});

test("json: array argument", async () =>
{
	assert.equal(await compile(jsonLib + "@typeOf([1, 2, 3])", "html"), NL + "array");
	assert.equal(await compile(jsonLib + "@show([1, 2, 3])", "html"), NL + "[1,2,3]");
});

test("json: object argument with nested structure", async () =>
{
	assert.equal(
		await compile(jsonLib + `@show({"a": [1, {"b": 2}], "s": "hi"})`, "html"),
		NL + `{"a":[1,{"b":2}],"s":"hi"}`,
	);
});

test("json: mixes with parsed-block args in the same call", async () =>
{
	assert.equal(await compile(jsonLib + `@key({"x": 9})[x]`, "html"), NL + "9");
});

test("json: nested @-call interpolates into a JSON string", async () =>
{
	const src = `@@@html\nfunction who() { return "Alice"; }\nfunction show(x) { return JSON.stringify(x); }\n@@@\n@show({"who": "@who"})`;
	assert.equal(await compile(src, "html"), NL + `{"who":"Alice"}`);
});

// A jsonBlock only refuses a leading *named* call — the shape a desugared prose
// wrapper takes — so an identity or raw block can open one.
test("json: a leading @[...] opens a json block rather than prose", async () =>
{
	assert.equal(await compile(jsonLib + "@show(@[hi])", "html"), NL + `"hi"`);
	assert.equal(await compile(jsonLib + "@typeOf(@[hi])", "html"), NL + "string");
	assert.equal(await compile(jsonLib + "@show(@[[hi]])", "html"), NL + `"<p>hi</p>"`);
	assert.equal(await compile(jsonLib + "@show(@{42})", "html"), NL + "42");
});

// The lookahead still has to reject the wrapper a bare call followed by prose
// desugars to, or the prose would be handed to JSON5.parse.
test("json: a leading named call is still prose, not a json argument", async () =>
{
	assert.equal(await compile(jsonLib + "@show({a: 1}) then *prose*", "html"), NL + `<p>{"a":1} then <em>prose</em></p>`);
	assert.equal(await compile("@@@html\nfunction id(x) { return x; }\n@@@\n@id[a] tail (@id[b]) end", "html"), NL + "<p>a tail b end</p>");
});

test("json: @) escapes a literal close paren inside a string", async () =>
{
	assert.equal(await compile(jsonLib + `@show([":@)"])`, "html"), NL + `[":)"]`);
});

test("json: hashed delimiters let a bare ) stay literal", async () =>
{
	assert.equal(await compile(jsonLib + `@show#([":) "])#`, "html"), NL + `[":) "]`);
});

test("json: invalid JSON rejects the compile", async () =>
{
	await assert.rejects(() => compile(jsonLib + "@show([1 2])", "html"));
});

test("json: JSON5 leniency accepts trailing commas and unquoted keys", async () =>
{
	assert.equal(await compile(jsonLib + `@show([1, 2,])`, "html"), NL + `[1,2]`);
	assert.equal(await compile(jsonLib + `@show({a: 1,})`, "html"), NL + `{"a":1}`);
});

// @[...] / @[[...]] render to text, so inside a json block their output is
// quoted into a JSON string; anywhere else the quotes would show up verbatim in
// the document, so they're left off.
test("json: an @[...] identity block becomes a JSON string", async () =>
{
	assert.equal(await compile(jsonLib + `@show({a: @[hi]})`, "html"), NL + `{"a":"hi"}`);
	assert.equal(await compile(jsonLib + `@show([@[a], @[b]])`, "html"), NL + `["a","b"]`);
	assert.equal(await compile(jsonLib + `@show({@[k]: 1})`, "html"), NL + `{"k":1}`);
	assert.equal(await compile(jsonLib + `@typeOfA({a: @[hi]})`, "html"), NL + "string");
});

test("json: an @[[...]] identity block becomes a JSON string", async () =>
{
	assert.equal(await compile(jsonLib + `@show({a: @[[hi]]})`, "html"), NL + `{"a":"<p>hi</p>"}`);
});

test("json: a rendered identity block is escaped, not pasted, into the JSON", async () =>
{
	assert.equal(await compile(jsonLib + `@show({a: @[he said @{"}hi]})`, "html"), NL + `{"a":"he said \\"hi"}`);
	assert.equal(await compile(jsonLib + `@show({a: @[[one\n\ntwo]]})`, "html"), NL + `{"a":"<p>one</p>\\n\\n<p>two</p>"}`);
});

test("json: an identity block inside a JSON string isn't re-quoted", async () =>
{
	assert.equal(await compile(jsonLib + `@show({a: "x@[hi]y"})`, "html"), NL + `{"a":"xhiy"}`);
	assert.equal(await compile(jsonLib + `@show({a: '@[hi]'})`, "html"), NL + `{"a":"hi"}`);
	assert.equal(await compile(jsonLib + String.raw`@show({a: "x\"@[hi]"})`, "html"), NL + `{"a":"x\\"hi"}`);
});

// A quote inside a nested call's own argument belongs to that call, not to the
// JSON text, so it must not flip the scan's in-a-string state.
test("json: a quote inside a nested call's argument doesn't shift the scan", async () =>
{
	assert.equal(await compile(jsonLib + `@show({a: @quoted[q@{"}], b: @[hi]})`, "html"), NL + `{"a":"q\\"","b":"hi"}`);
});

// Only a json body's *immediate* identity child is quoted: one nested inside
// another call's parsed-block argument is ordinary string interpolation.
test("json: an identity nested in a call argument isn't quoted", async () =>
{
	assert.equal(await compile(jsonLib + `@show({a: "@up[@[hi]]"})`, "html"), NL + `{"a":"HI"}`);
});

test("identity: output is never quoted outside a json block", async () =>
{
	assert.equal(await compile(jsonLib + `@up[@[hi]]`, "html"), NL + "HI");
	assert.equal(await compile(jsonLib + `@up{@[hi]}`, "html"), NL + "HI");
	assert.equal(await compile("x @[hi] y", "html"), "<p>x hi y</p>");
	assert.equal(await compile("@{a @[b] c}", "html"), "a b c");
});


// ============================================================================
// Escapes
// ============================================================================

test("escape: @ escapes @", async () => assert.equal(await compile("@@", "html"), "@"));
test("escape: @ escapes *", async () => assert.equal(await compile("@*", "html"), "*"));
test("escape: @ escapes _", async () => assert.equal(await compile("@_", "html"), "_"));
test("escape: @ escapes backtick", async () => assert.equal(await compile("@`", "html"), "`"));
test("escape: @{[} escapes [ via raw mode", async () => assert.equal(await compile("@{[}", "html"), "["));
test("escape: @{]} escapes ] via raw mode", async () => assert.equal(await compile("@{]}", "html"), "]"));
// @[ is no longer a bracket escape (it opens an inline identity block); a stray,
// unclosed @[ still falls back to a literal [ so old documents don't break hard.
test("escape: a stray unclosed @[ falls back to a literal [", async () =>
	assert.equal(await compile("@[", "html"), "["));
test("escape: @] still yields a literal ]", async () => assert.equal(await compile("@]", "html"), "]"));
test("escape: @ escapes <", async () => assert.equal(await compile("@<", "html"), "<"));

test("escape: @$ yields a literal $ via the stdlib special-case", async () =>
{
	assert.equal(await compile("@$", "html"), "$");
});

test("escape: multiple escapes in one paragraph", async () =>
{
	assert.equal(await compile("a @@ b @* c", "html"), "<p>a @ b * c</p>");
});


// ============================================================================
// Whitespace, boundaries, pathological inputs
// ============================================================================

test("misc: empty input -> empty output", async () =>
{
	assert.equal(await compile("", "html"), "");
});

test("misc: literal brackets in prose survive the @text re-parse", async () =>
{
	// Text desugars to (@text[...]); literal [ ] must not be read as the arg's
	// own delimiters (a leading [ would otherwise form a spurious [[ opener).
	assert.equal(await compile("a [b] c", "html"), "<p>a [b] c</p>");
	assert.equal(await compile("[b]", "html"), "<p>[b]</p>");
	assert.equal(await compile("[]", "html"), "<p>[]</p>");
	// Inside emphasis, and as a parsed-block argument re-matched as a document.
	assert.equal(await compile("**a]b**", "html"), "<p><strong>a]b</strong></p>");
	assert.equal(
		await compile(lib + "(@id [[student[s'] learning]])", "html"),
		NL + "<p>student[s'] learning</p>",
	);
	// A real link still wins over the bracket escape.
	assert.equal(await compile("[t](u)", "html"), `<p><a href="u">t</a></p>`);
});

test("misc: single character", async () =>
{
	assert.equal(await compile("a", "html"), "<p>a</p>");
});

test("misc: plain text passes through", async () =>
{
	assert.equal(await compile("plain text", "html"), "<p>plain text</p>");
});

test("misc: two paragraphs preserve blank-line separator", async () =>
{
	assert.equal(await compile("p1\n\np2", "html"), "<p>p1</p>\n\n<p>p2</p>");
});

test("misc: raw HTML in a paragraph passes through untouched", async () =>
{
	assert.equal(await compile("<span>x</span>", "html"), "<span>x</span>");
});

test("misc: HTML mid-paragraph passes through", async () =>
{
	assert.equal(
		await compile("before <em>html</em> after", "html"),
		"<p>before <em>html</em> after</p>",
	);
});

test("misc: function call inside an HTML tag is interpreted", async () =>
{
	const src = `${lib}<div class="@up [hi]">`;
	assert.equal(await compile(src, "html"), `${NL}<div class="HI">`);
});

test("misc: long line of plain characters", async () =>
{
	const long = "x".repeat(500);
	assert.equal(await compile(long, "html"), `<p>${long}</p>`);
});


// ============================================================================
// Error reporting
// ============================================================================

test("error: undefined function call rejects and logs red ANSI with the name", async (t) =>
{
	const logs = [];
	t.mock.method(console, "log", (...args) => { logs.push(args.join(" ")); });

	await assert.rejects(compile("@undefined[x]", "html"));

	const combined = logs.join("\n");
	assert.match(combined, /\x1b\[1;31m/, "log should contain bold-red ANSI");
	assert.match(combined, /\x1b\[0m/, "log should contain ANSI reset");
	assert.match(combined, /undefined/, "log should reference 'undefined'");
	assert.match(combined, /\x1b\[1;31m\s*1\x1b\[0m/, "line 1 should be highlighted");
});

test("error: undefined function error highlights its own line, not a later one", async (t) =>
{
	// Regression: generated @text/@paragraph calls were not captured during
	// desugar, so getCode's call index drifted and the error was attributed to a
	// later line. Here @bad is on line 3; the highlighted line must be 3.
	const logs = [];
	t.mock.method(console, "log", (...args) => { logs.push(args.join(" ")); });

	await assert.rejects(compile("first line\n\n@bad[x]\n\nlast line", "html"));

	const combined = logs.join("\n");
	assert.match(combined, /\x1b\[1;31m\s*3\x1b\[0m/, "line 3 (the @bad call) should be highlighted");
	assert.doesNotMatch(combined, /\x1b\[1;31m\s*5\x1b\[0m/, "line 5 must not be highlighted");
});

test("error: undefined function nested in a [[ ]] parsed block maps to its real line", async (t) =>
{
	// parsedBlock re-matches its body as a fresh document, so without a line-base
	// offset the captured location would read line 1. @f is on line 3 here.
	const logs = [];
	t.mock.method(console, "log", (...args) => { logs.push(args.join(" ")); });

	await assert.rejects(compile("a\n\n@bold[[@f]]\n\nb", "html"));

	const combined = logs.join("\n");
	assert.match(combined, /\x1b\[1;31m\s*3\x1b\[0m/, "line 3 (the nested @f) should be highlighted");
	assert.doesNotMatch(combined, /\x1b\[1;31m\s*1\x1b\[0m/, "line 1 must not be highlighted");
});

test("error: error inside declaration block body maps to original-source line", async (t) =>
{
	const logs = [];
	t.mock.method(console, "log", (...args) => { logs.push(args.join(" ")); });

	await assert.rejects(
		compile("@@@html\nthrow new Error(\"boom\");\n@@@", "html"),
		/boom/,
	);

	const combined = logs.join("\n");
	assert.match(
		combined,
		/\x1b\[1;31m\s*2\x1b\[0m \| \x1b\[1;31mthrow new Error\("boom"\);\x1b\[0m/,
		"declaration-block error should highlight line 2 whole-line red",
	);
});

test("error: successful compile produces no logSourceError output", async (t) =>
{
	const logs = [];
	t.mock.method(console, "log", (...args) => { logs.push(args.join(" ")); });

	await compile("# H", "html");

	const combined = logs.join("\n");
	assert.doesNotMatch(combined, /\x1b\[1;31m/);
});


// ============================================================================
// Idempotency / no state bleed between calls
// ============================================================================

test("state: same input twice -> same output", async () =>
{
	const a = await compile("# X", "html");
	const b = await compile("# X", "html");
	assert.equal(a, b);
	assert.equal(a, "<h1>X</h1>");
});

test("state: different inputs back-to-back don't leak state", async () =>
{
	assert.equal(await compile("# A", "html"), "<h1>A</h1>");
	assert.equal(await compile("# B", "html"), "<h1>B</h1>");
	assert.equal(await compile("# A", "html"), "<h1>A</h1>");
});

test("state: nested calls then sugar", async () =>
{
	assert.equal(await compile(lib + "(@up [(@up [hi])])", "html"), NL + "HI");
	assert.equal(await compile("**bold**", "html"), "<p><strong>bold</strong></p>");
});


// ============================================================================
// Output format parameter
// ============================================================================

test("format: tex format uses tex stdlib", async () =>
{
	assert.equal(await compile("# X", "tex"), "\\section{X}");
});

test("format: tex format applies tex sugar throughout", async () =>
{
	assert.equal(await compile("**bold**", "tex"), "\\textbf{bold}");
});

test("format: declaration-block scope follows the format param", async () =>
{
	// Same source, different format -> different declaration block runs.
	const src = `@@@html\nfunction f() { return "H"; }\n@@@tex\nfunction f() { return "T"; }\n@@@\n@f`;
	assert.equal(await compile(src, "html"), NL + "H");
	assert.equal(await compile(src, "tex"), NL + "T");
});

test("format: unknown format is allowed (no stdlib defaults applied)", async () =>
{
	// User-defined declaration block under an unknown scope still runs and is usable.
	const src = `@@@bogus\nfunction greet() { return "hello"; }\n@@@\n@greet`;
	assert.equal(await compile(src, "bogus"), NL + "hello");
});


// ============================================================================
// Raw mode (compile's `raw` flag / CLI -r|--raw)
// ============================================================================

test("raw: markup is left literal, only @-calls are interpreted", async () =>
{
	// In raw mode the whole document behaves like the body of @{}: headings and
	// emphasis stay literal, but @bold still runs.
	const out = await compile("# not a heading\n**not bold** @bold[but this is]", "html", { raw: true });
	assert.equal(out, "# not a heading\n**not bold** <strong>but this is</strong>");
});

test("raw: same source differs from normal mode", async () =>
{
	const src = "# H\n";
	assert.equal(await compile(src, "html"), "<h1>H</h1>\n");
	assert.equal(await compile(src, "html", { raw: true }), "# H\n");
});

test("raw: parsed-block arguments to @-calls are still parsed", async () =>
{
	// The [ ] argument of a raw-mode @-call is a parsed inline block, so emphasis
	// inside it is interpreted even though the surrounding document is raw.
	const out = await compile("@bold[**inner**]", "html", { raw: true });
	assert.equal(out, "<strong><strong>inner</strong></strong>");
});

test("raw: declaration blocks are still interpreted", async () =>
{
	// The @@@ block defines `shout` (and is stripped from output); markup stays
	// literal, but the @shout call runs.
	const src = `@@@html\nfunction shout(x) { return x.toUpperCase(); }\n@@@\n# literal @shout[hi]`;
	const out = await compile(src, "html", { raw: true });
	assert.equal(out, "\n# literal HI");
});


// ============================================================================
// Post-compile hooks
// ============================================================================

test("document hook: stdlib document wraps the compiled body", async () =>
{
	stdlib.html.document = body => `<doc>${body}</doc>`;
	try
	{
		assert.equal(await compile("# X", "html"), "<doc><h1>X</h1></doc>");
	}
	finally
	{
		delete stdlib.html.document;
	}
});

test("document hook: no document registered leaves body unchanged", async () =>
{
	assert.equal(await compile("# X", "html"), "<h1>X</h1>");
});

test("document hook: hook is not callable inline as @document[...]", async (t) =>
{
	t.mock.method(console, "log", () => {});
	stdlib.html.document = body => `WRAP(${body})`;
	try
	{
		// `document` is excluded from the globalThis splat, so referencing it
		// inline should fail with the standard undefined-function error path.
		await assert.rejects(compile("@document[x]", "html"));
	}
	finally
	{
		delete stdlib.html.document;
	}
});


// ============================================================================
// Isolation: serialization and globalThis hygiene
// ============================================================================

test("isolation: concurrent compiles do not corrupt each other", async () =>
{
	// Run several compiles that overlap on the await inside runCode. Without
	// serialization, desugar()/getCode()'s module-level state gets stomped
	// across awaits and outputs cross-contaminate.
	const [a, b, c] = await Promise.all([
		compile("# A", "html"),
		compile("# B", "tex"),
		compile("# C", "html"),
	]);
	assert.match(a, /<h1>A<\/h1>/);
	assert.match(b, /\\section\{B\}/);
	assert.match(c, /<h1>C<\/h1>/);
	// And the formats must not have cross-contaminated.
	assert.doesNotMatch(a, /\\chapter/);
	assert.doesNotMatch(b, /<h1>/);
});

test("isolation: compile does not leak stdlib onto globalThis", async () =>
{
	const sentinelKey = "heading"; // present in both html and tex stdlib
	const hadBefore = Object.hasOwn(globalThis, sentinelKey);
	const valueBefore = hadBefore ? globalThis[sentinelKey] : undefined;

	await compile("# X", "html");

	assert.equal(Object.hasOwn(globalThis, sentinelKey), hadBefore);
	if (hadBefore) assert.equal(globalThis[sentinelKey], valueBefore);
});

test("isolation: pre-existing globalThis entry is restored after compile", async () =>
{
	const sentinel = Symbol("preexisting");
	const had = Object.hasOwn(globalThis, "bold");
	const prior = had ? globalThis.bold : undefined;

	globalThis.bold = sentinel;
	try
	{
		await compile("**x**", "html");
		assert.equal(globalThis.bold, sentinel);
	}
	finally
	{
		if (had) globalThis.bold = prior;
		else delete globalThis.bold;
	}
});

test("isolation: user declaration block still overrides the stdlib name", async () =>
{
	const src = `@@@html\nfunction heading(body, n) { return "OVERRIDE:" + body; }\n@@@\n# X`;
	assert.equal(await compile(src, "html"), NL + "OVERRIDE:X");
});
