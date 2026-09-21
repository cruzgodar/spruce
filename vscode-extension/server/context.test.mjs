import { strict as assert } from "node:assert";
import test from "node:test";
import { CODE, DECLARATION, HTML, JSON_BLOCK, MARKUP, MATH, RAW, contextAt } from "./context.mjs";

// Each case marks the offset under test with a `|`, which is stripped before
// scanning — so the fixtures read the way the document looks in the editor.
function contextOf(marked) {
	const offset = marked.indexOf("|");
	assert.notEqual(offset, -1, "fixture needs a | caret marker");
	return contextAt(marked.slice(0, offset) + marked.slice(offset + 1), offset);
}

test("plain prose is markup", () => {
	assert.equal(contextOf("hello |world"), MARKUP);
	assert.equal(contextOf("|"), MARKUP);
	assert.equal(contextOf("# A *heading*|"), MARKUP);
	assert.equal(contextOf("- an item|"), MARKUP);
});

test("declaration blocks are their own context", () => {
	assert.equal(contextOf("@@@html\nconst x = |1;\n@@@\n"), DECLARATION);
	assert.equal(contextOf("@@@\nconst x = 1;\n@@@\nafter|"), MARKUP);
	// The opener line counts as part of the block it opens: only its `alnum*`
	// format tag can go there, so markup has no business being live on it.
	assert.equal(contextOf("@@@ht|ml\nx\n@@@\n"), DECLARATION);
});

test("a declaration block's @@@ tag line closes one block and opens the next", () => {
	assert.equal(contextOf("@@@html\na\n@@@latex\nb|\n@@@\n"), DECLARATION);
	assert.equal(contextOf("@@@html\na\n@@@latex\nb\n@@@\nc|"), MARKUP);
});

// The point of the lexical scan: a block that hasn't been closed yet is still
// the context the caret is in.
test("an unterminated declaration block runs to the end of the document", () => {
	assert.equal(contextOf("@@@html\nconst a = 1;\nconst b = |"), DECLARATION);
});

test("markup isn't live inside a raw @{ } block", () => {
	assert.equal(contextOf("@{raw | text}"), RAW);
	assert.equal(contextOf("@{raw text}|"), MARKUP);
	assert.equal(contextOf("@up{raw | text}"), RAW);
	assert.equal(contextOf("@up{a}|"), MARKUP);
});

test("markup is live inside a parsed or inline block", () => {
	assert.equal(contextOf("@[in|line]"), MARKUP);
	assert.equal(contextOf("@[[par|sed]]"), MARKUP);
	assert.equal(contextOf("@up[ar|gument]"), MARKUP);
	// ... including one nested in a raw block.
	assert.equal(contextOf("@{raw @up[par|sed] raw}"), MARKUP);
	assert.equal(contextOf("@{raw @up[parsed] r|aw}"), RAW);
});

test("a json ( ) argument is raw", () => {
	assert.equal(contextOf("@show({a: |1})"), JSON_BLOCK);
	assert.equal(contextOf("@show({a: 1})|"), MARKUP);
	assert.equal(contextOf("@show ({a: |1})"), JSON_BLOCK);
});

test("a call's later argument blocks still open after an earlier one closes", () => {
	assert.equal(contextOf("@key({x: 9})[|x]"), MARKUP);
	assert.equal(contextOf("@key[x]({y: |9})"), JSON_BLOCK);
	assert.equal(contextOf("@f{a}{b|}"), RAW);
});

test("hashed delimiters open and close the same block", () => {
	assert.equal(contextOf("@##{raw | text}##"), RAW);
	assert.equal(contextOf("@##{raw}te|xt}##"), RAW);
	assert.equal(contextOf("@##{raw text}##|"), MARKUP);
	assert.equal(contextOf("@show#({a: |1})#"), JSON_BLOCK);
	assert.equal(contextOf("@##[[par|sed]]##"), MARKUP);
});

test("code blocks and inline code are raw", () => {
	assert.equal(contextOf("```js\nconst a = |1;\n```\n"), CODE);
	assert.equal(contextOf("```\ncode\n```\naf|ter"), MARKUP);
	assert.equal(contextOf("a `in|line` b"), CODE);
	assert.equal(contextOf("a `inline` |b"), MARKUP);
});

test("an unterminated code fence runs to the end of the document", () => {
	assert.equal(contextOf("```js\nconst a = |"), CODE);
});

test("a ``` run that isn't a fence line opens inline code instead", () => {
	assert.equal(contextOf("```not a f|ence``` tail"), CODE);
	assert.equal(contextOf("```not a fence``` t|ail"), MARKUP);
});

test("math is raw", () => {
	assert.equal(contextOf("a $x_|1$ b"), MATH);
	assert.equal(contextOf("a $x$ |b"), MARKUP);
	assert.equal(contextOf("a $$x_|1$$ b"), MATH);
	assert.equal(contextOf("$$\nx_|1\n$$\n"), MATH);
	assert.equal(contextOf("$$\nx\n$$\n|after"), MARKUP);
});

// A lone $ or ` would otherwise poison the rest of the document; the grammar
// won't let either span a blank line, and neither does the scan.
test("an unclosed inline delimiter gives up at a blank line", () => {
	assert.equal(contextOf("costs $5 and\n\nlat|er"), MARKUP);
	assert.equal(contextOf("a `b\n\nlat|er"), MARKUP);
	assert.equal(contextOf("costs $5 and |more"), MATH);
});

test("an html tag is raw to the end of its line", () => {
	assert.equal(contextOf('<div class="a|_b">'), HTML);
	assert.equal(contextOf('<div>\n|next'), MARKUP);
	// Only at the head of a line — mid-paragraph a < is ordinary prose.
	assert.equal(contextOf("a < b |c"), MARKUP);
});

test("a link's display text is markup and its url is raw", () => {
	assert.equal(contextOf("[dis|play](url)"), MARKUP);
	assert.equal(contextOf("[display](ur|l)"), RAW);
	assert.equal(contextOf("[display](url)|"), MARKUP);
	assert.equal(contextOf("[display] |not a link"), MARKUP);
});

test("escapes don't open anything", () => {
	assert.equal(contextOf("@{ @} still raw|"), RAW);
	assert.equal(contextOf("@@|"), MARKUP);
	assert.equal(contextOf("@$ |after"), MARKUP);
	// @@@ mid-line is an escaped @ plus an @, not a declaration fence.
	assert.equal(contextOf("x @@@ y|"), MARKUP);
});

test("blocks nest", () => {
	assert.equal(contextOf("@[[a @{b @up[c|] d} e]]"), MARKUP);
	assert.equal(contextOf("@[[a @{b @up[c] d|} e]]"), RAW);
	assert.equal(contextOf("@[[a @{b @up[c] d} e|]]"), MARKUP);
	assert.equal(contextOf("@show({a: @[h|i]})"), MARKUP);
	assert.equal(contextOf("@show({a: @[hi], b|: 1})"), JSON_BLOCK);
});

test("a declaration block inside a parsed block is still a declaration block", () => {
	assert.equal(contextOf("@[[\n@@@html\nconst a = |1;\n@@@\n]]"), DECLARATION);
});

// Raw bodies aren't re-scanned for fences, so a ``` or @@@ line inside one stays
// part of the raw block.
test("line-anchored constructs don't open inside a raw block", () => {
	assert.equal(contextOf("@{\n```\nstill |raw\n```\n}"), RAW);
	assert.equal(contextOf("@{\n@@@\nstill |raw\n@@@\n}"), RAW);
});

test("CRLF line breaks are handled", () => {
	assert.equal(contextOf("@@@html\r\nconst x = |1;\r\n@@@\r\n"), DECLARATION);
	assert.equal(contextOf("@@@html\r\nx\r\n@@@\r\naf|ter"), MARKUP);
});

test("offsets outside the text are clamped", () => {
	assert.equal(contextAt("abc", -5), MARKUP);
	assert.equal(contextAt("@{abc", 999), RAW);
});
