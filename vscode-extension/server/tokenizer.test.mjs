import { test } from "node:test";
import assert from "node:assert/strict";
import { collectTokens, tokenize } from "./tokenizer.mjs";

test("heading line emits a single heading token over the whole line", () => {
	const tokens = collectTokens("# Hello\n");
	const heading = tokens.find(t => t.type === "heading");
	assert.ok(heading);
	assert.equal(heading.start, 0);
	// Heading spans "# Hello" (no trailing newline).
	assert.equal(heading.end, 7);
});

test("bold splits into marker + bold + marker", () => {
	const tokens = collectTokens("**hi**");
	const markers = tokens.filter(t => t.type === "marker");
	const bold = tokens.find(t => t.type === "bold");
	assert.equal(markers.length, 2);
	assert.equal(markers[0].start, 0); assert.equal(markers[0].end, 2);
	assert.equal(markers[1].start, 4); assert.equal(markers[1].end, 6);
	assert.equal(bold.start, 2); assert.equal(bold.end, 4);
});

test("italic splits into marker + italic + marker (1-char markers)", () => {
	const tokens = collectTokens("*hi*");
	const markers = tokens.filter(t => t.type === "marker");
	const it = tokens.find(t => t.type === "italic");
	assert.equal(markers.length, 2);
	assert.equal(markers[0].end - markers[0].start, 1);
	assert.equal(it.start, 1); assert.equal(it.end, 3);
});

test("***boldItalic*** has 3-char markers and inner boldItalic", () => {
	const tokens = collectTokens("***hi***");
	const markers = tokens.filter(t => t.type === "marker");
	assert.equal(markers.length, 2);
	assert.equal(markers[0].end - markers[0].start, 3);
	assert.ok(tokens.find(t => t.type === "boldItalic"));
});

test("bold link keeps linkText type and gains the bold modifier", () => {
	const tokens = collectTokens("**[text](url)**");
	const link = tokens.find(t => t.type === "linkText");
	assert.ok(link, "inner link is still recognized (not swallowed by bold)");
	assert.equal(link.modifiers & 1, 1, "linkText carries the bold modifier bit");
	// Plain bold text would be type `bold`; here there is none, only the link.
	assert.ok(!tokens.find(t => t.type === "bold"));
});

test("italic nested in bold composes both modifiers on the inner span", () => {
	const tokens = collectTokens("**a *b* c**");
	// `b` is the italic content inside the bold span -> both bits set.
	const inner = tokens.find(t => t.type === "italic");
	assert.ok(inner);
	assert.equal(inner.modifiers, 0b11, "bold | italic");
	// The surrounding plain text is bold-only.
	const boldGap = tokens.find(t => t.type === "bold");
	assert.ok(boldGap);
	assert.equal(boldGap.modifiers, 0b01, "bold only");
});

test("tokenize encodes the modifier bitmask (not a hardcoded 0)", () => {
	const data = tokenize("**[t](u)**");
	// Every token row is [dLine, dChar, len, typeIdx, modifiers]; at least one
	// row must carry the bold bit now that emphasis composes.
	let sawModifier = false;
	for (let i = 4; i < data.length; i += 5) if (data[i] & 1) sawModifier = true;
	assert.ok(sawModifier, "expected at least one token with the bold modifier set");
});

test("inline `code` splits backticks + content (backticks are string)", () => {
	const tokens = collectTokens("`x`");
	const strings = tokens.filter(t => t.type === "string");
	const code = tokens.find(t => t.type === "inlineCode");
	assert.equal(strings.length, 2);
	assert.equal(strings[0].start, 0); assert.equal(strings[0].end, 1);
	assert.equal(strings[1].start, 2); assert.equal(strings[1].end, 3);
	assert.equal(code.start, 1); assert.equal(code.end, 2);
});

test("fenced ``` ... ``` block splits triple-backticks + body", () => {
	const tokens = collectTokens("```\nfoo\n```\n");
	const fences = tokens.filter(t => t.type === "string");
	const body = tokens.find(t => t.type === "codeBlock");
	assert.equal(fences.length, 2);
	assert.equal(fences[0].end - fences[0].start, 3);
	assert.equal(fences[1].end - fences[1].start, 3);
	assert.ok(body);
});

test("``` block with language tag emits a languageTag token", () => {
	const tokens = collectTokens("```js\nfoo\n```\n");
	const lang = tokens.find(t => t.type === "languageTag");
	assert.ok(lang);
	assert.equal(lang.end - lang.start, 2);
});

test("inline $math$ delimiters are string-colored", () => {
	const src = "$x$";
	const tokens = collectTokens(src);
	const strings = tokens.filter(t => t.type === "string");
	assert.ok(strings.find(t => t.start === 0 && t.end === 1));
	assert.ok(strings.find(t => t.start === 2 && t.end === 3));
});

test("@name[body] colors @ and name as spruceFunction, body recurses", () => {
	const tokens = collectTokens("@name[body]");
	const fns = tokens.filter(t => t.type === "spruceFunction");
	// One for the @, one for the identifier `name`.
	assert.ok(fns.length >= 2);
	assert.equal(fns[0].start, 0);
	assert.equal(fns[0].end, 1);
});

test("wrapped (@name[body]) colors @ and name as spruceFunction", () => {
	const src = "(@name[body])";
	const tokens = collectTokens(src);
	const fns = tokens.filter(t => t.type === "spruceFunction");
	// At least one for the @ and one for the identifier `name`.
	assert.ok(fns.length >= 2);
	const atTok = fns.find(t => t.start === src.indexOf("@"));
	assert.ok(atTok, "expected a token starting at the @ position");
	assert.equal(atTok.end - atTok.start, 1);
});

test("wrapped (@name[body]) colors its parens as spruceFunction, inner brackets stay bracket colors", () => {
	const src = "(@f[x])";
	const tokens = collectTokens(src);
	const open = tokens.find(t => t.start === 0 && t.end === 1);
	const close = tokens.find(t => t.start === src.length - 1 && t.end === src.length);
	assert.equal(open.type, "spruceFunction", "open paren should be purple");
	assert.equal(close.type, "spruceFunction", "close paren should be purple");
	// The inner [ ] still take a sequential bracket color, not spruceFunction.
	const innerOpen = tokens.find(t => src[t.start] === "[");
	assert.ok(innerOpen.type.startsWith("bracket"));
});

test("link URL is highlighted as string", () => {
	const tokens = collectTokens("[text](https://example.com)");
	const strings = tokens.filter(t => t.type === "string");
	assert.ok(strings.find(t => t.start === 7 && t.end === 26));
});

test("@function inside a heading keeps its purple coloring", () => {
	const src = "# Hello @name[x]\n";
	const tokens = collectTokens(src);
	const fns = tokens.filter(t => t.type === "spruceFunction");
	// The @ and the identifier `name` stay purple inside the heading.
	assert.ok(fns.find(t => t.start === src.indexOf("@") && t.end === src.indexOf("@") + 1));
	assert.ok(fns.find(t => t.start === src.indexOf("name")));
	// The surrounding text is still heading-colored, filled around the call.
	const heading = tokens.filter(t => t.type === "heading");
	assert.ok(heading.find(t => t.start === 0 && t.end === src.indexOf("@")));
});

test("@function inside link display text keeps its purple coloring", () => {
	const src = "[a @name[x] b](url)";
	const tokens = collectTokens(src);
	const fns = tokens.filter(t => t.type === "spruceFunction");
	assert.ok(fns.find(t => t.start === src.indexOf("@") && t.end === src.indexOf("@") + 1));
	assert.ok(fns.find(t => t.start === src.indexOf("name")));
	// The display text around the call stays linkText.
	const linkText = tokens.filter(t => t.type === "linkText");
	assert.ok(linkText.find(t => t.start === 1 && t.end === src.indexOf("@")));
});

test("@function inside a link URL keeps its purple coloring", () => {
	const src = "[text](@name[x])";
	const tokens = collectTokens(src);
	const fns = tokens.filter(t => t.type === "spruceFunction");
	assert.ok(fns.find(t => t.start === src.indexOf("@") && t.end === src.indexOf("@") + 1));
	assert.ok(fns.find(t => t.start === src.indexOf("name")));
});

test("escaped @x colors the whole @ + char sequence as escape", () => {
	const src = "a @] b";
	const tokens = collectTokens(src);
	const atIdx = src.indexOf("@");
	const esc = tokens.find(t => t.type === "escape" && t.start === atIdx);
	assert.ok(esc, "the escape sequence is one escape token");
	// Covers both the @ and the escaped character.
	assert.equal(esc.end, atIdx + 2);
	// No part of it is colored as a function or raw string.
	assert.ok(!tokens.find(t => t.type === "spruceFunction" && t.start === atIdx));
});

test("invalid @ (followed by a non-identifier) is colored invalid", () => {
	const src = "foo @ .";
	const tokens = collectTokens(src);
	const inv = tokens.find(t => t.type === "invalid");
	assert.ok(inv, "the stray @ is flagged invalid");
	assert.equal(src[inv.start], "@");
});

test("invalid @ inside a raw block is also colored invalid", () => {
	const src = "@{ @ ) }";
	const inv = collectTokens(src).find(t => t.type === "invalid");
	assert.ok(inv, "invalid @ surfaces in raw contexts too");
});

test("function call inside an HTML tag is highlighted as a function", () => {
	const src = "<div class=\"@cls\">";
	const fns = collectTokens(src).filter(t => t.type === "spruceFunction");
	assert.ok(fns.find(t => src.slice(t.start, t.end) === "cls"), "the @func name is highlighted");
	// The surrounding tag text is still raw-colored.
	assert.ok(collectTokens(src).find(t => t.type === "string"));
});

test("raw block content is string, with function-call gaps preserved", () => {
	// @outer{ raw stuff @inner[x] more } — outer is functionCall_raw.
	const tokens = collectTokens("@outer{ raw @inner[x] more }");
	const strings = tokens.filter(t => t.type === "string");
	const fns = tokens.filter(t => t.type === "spruceFunction");
	assert.ok(strings.length >= 1, "expected at least one string token in raw block");
	// The inner @ and identifier should still emit function tokens.
	assert.ok(fns.find(t => t.start > 6 && t.end <= 20), "expected inner function tokens preserved");
	// No string token should overlap a function token.
	for (const s of strings) {
		for (const f of fns) {
			const overlap = s.start < f.end && f.start < s.end;
			assert.ok(!overlap, `string ${JSON.stringify(s)} overlaps function ${JSON.stringify(f)}`);
		}
	}
});

test("@[...] identity block colors the @ as a function and recurses into the body", () => {
	const src = "@[hi *x*]";
	const tokens = collectTokens(src);
	const at = tokens.find(t => t.start === 0 && t.end === 1);
	assert.equal(at.type, "spruceFunction", "the @ is a function marker");
	// The body recurses, so the inner emphasis still highlights.
	assert.ok(tokens.find(t => t.type === "italic"), "inline sugar inside the block highlights");
});

test("@[[...]] identity block colors the @ and re-parses its body as a document", () => {
	const src = "@[[# Title]]";
	const tokens = collectTokens(src);
	const at = tokens.find(t => t.start === 0 && t.end === 1);
	assert.equal(at.type, "spruceFunction", "the @ is a function marker");
	// The body is a parsed sub-document, so the heading inside highlights.
	assert.ok(tokens.find(t => t.type === "heading"), "block sugar inside the block highlights");
});

test("parsed block inside a raw block keeps its body parsed, not raw", () => {
	// @{ before @f[[ hello *world* ]] after } — the [[ ]] argument is a parsed
	// sub-document, so its plain text " hello " must NOT take the raw string color,
	// while the raw text " before " / " after " around the call still does.
	const src = "@{ before @f[[ hello *world* ]] after }";
	const tokens = collectTokens(src);
	const strings = tokens.filter(t => t.type === "string");
	const stringText = s => src.slice(s.start, s.end);
	// The raw text outside the call stays string-colored.
	assert.ok(strings.find(s => stringText(s) === " before "), "raw text before the call is string");
	assert.ok(strings.find(s => stringText(s) === " after "), "raw text after the call is string");
	// No string token may fall inside the parsed block body (offsets 14..29).
	const bodyStart = src.indexOf("[[") + 2;
	const bodyEnd = src.indexOf("]]");
	for (const s of strings) {
		const inside = s.start >= bodyStart && s.end <= bodyEnd;
		assert.ok(!inside, `string ${JSON.stringify(stringText(s))} leaked into the parsed block body`);
	}
	// The emphasis inside the parsed block is still highlighted.
	assert.ok(tokens.find(t => t.type === "italic"), "italic inside the parsed block preserved");
});

test("json block highlights keys, string values, numbers, and true/false/null", () => {
	const src = `@show({"name": "spruce", "count": 42, "ok": true, "x": null})`;
	const tokens = collectTokens(src);
	const typeOf = text => {
		const idx = src.indexOf(text);
		return tokens.find(t => t.start === idx && t.end === idx + text.length)?.type;
	};
	assert.equal(typeOf('"name"'), "property", "key is a property");
	assert.equal(typeOf('"spruce"'), "jsonString", "string value is a jsonString");
	assert.equal(typeOf("42"), "number", "number value is a number");
	assert.equal(typeOf("true"), "boolean", "true is a boolean");
	assert.equal(typeOf("null"), "boolean", "null is a boolean");
	// Braces and brackets take bracket-pair colors.
	const brace = src.indexOf("{");
	assert.ok(
		tokens.find(t => t.start === brace && t.type.startsWith("bracket")),
		"the opening brace is a bracket token",
	);
});

test("json block: nested @-call keeps its function coloring without breaking the scan", () => {
	// @g[x] sits where a value goes; the surrounding "k" key and braces are still
	// tokenized, and the @g call keeps its own coloring with no overlap.
	const src = `@f({"k": @g[x]})`;
	const tokens = collectTokens(src);
	const key = tokens.find(t => t.type === "property" && src.slice(t.start, t.end) === '"k"');
	assert.ok(key, "the JSON key is a property token");
	const fns = tokens.filter(t => t.type === "spruceFunction");
	assert.ok(fns.find(t => src.slice(t.start, t.end) === "g"), "nested function token preserved");
	const jsonToks = tokens.filter(t => ["property", "jsonString", "number", "boolean"].includes(t.type));
	for (const s of jsonToks) {
		for (const fn of fns) {
			assert.ok(!(s.start < fn.end && fn.start < s.end), "no JSON token overlaps a function token");
		}
	}
});

test("json block: @-call inside a string value does not derail the scan", () => {
	// @who sits inside the string value; the value should still read as one string
	// (split only by the opaque @-call span), and the trailing brace stays a bracket.
	const src = `@show({"who": "@who"})`;
	const tokens = collectTokens(src);
	assert.ok(
		tokens.find(t => t.type === "property" && src.slice(t.start, t.end) === '"who"'),
		"the key is still a property",
	);
	assert.ok(
		tokens.find(t => t.type === "spruceFunction" && src.slice(t.start, t.end) === "who"),
		"the nested @who keeps function coloring",
	);
	const closeBrace = src.lastIndexOf("}");
	assert.ok(
		tokens.find(t => t.start === closeBrace && t.type.startsWith("bracket")),
		"the closing brace is a bracket token (scan recovered after the string)",
	);
	// The string token is split around the @-call span, so no jsonString token
	// overlaps the function tokens.
	const jsonToks = tokens.filter(t => ["property", "jsonString", "number", "boolean"].includes(t.type));
	const fns = tokens.filter(t => t.type === "spruceFunction");
	for (const s of jsonToks) for (const fn of fns) {
		assert.ok(!(s.start < fn.end && fn.start < s.end), "no JSON token overlaps a function token");
	}
});

test("json block: @[...] / @[[...]] identity calls highlight as values without overlap", () => {
	for (const call of ["@[hi]", "@[[hi]]"]) {
		const src = `@f([1, ${call}])`;
		const tokens = collectTokens(src);
		const at = tokens.find(t => t.start === src.indexOf("@", 1));
		assert.equal(at?.type, "spruceFunction", `${call}: the @ is a function marker`);
		const jsonToks = tokens.filter(t => ["property", "jsonString", "number", "boolean"].includes(t.type));
		const fns = tokens.filter(t => t.type === "spruceFunction");
		for (const s of jsonToks) for (const fn of fns) {
			assert.ok(!(s.start < fn.end && fn.start < s.end), `${call}: no JSON token overlaps a function token`);
		}
	}
});

test("json block: @[...] / @[[...]] inside a string value split the string, no overlap", () => {
	for (const call of ["@[hi]", "@[[hi]]"]) {
		const src = `@f({"k": "pre ${call} post"})`;
		const tokens = collectTokens(src);
		// The @ inside the string still gets function coloring.
		assert.ok(
			tokens.find(t => t.type === "spruceFunction" && t.start === src.indexOf("@", 1)),
			`${call}: the nested @ keeps function coloring inside the string`,
		);
		// The surrounding string text stays jsonString, split around the call.
		const strings = tokens.filter(t => t.type === "jsonString").map(t => src.slice(t.start, t.end));
		assert.ok(strings.some(s => s.includes("pre")) && strings.some(s => s.includes("post")),
			`${call}: the string text on both sides stays a jsonString`);
		// No jsonString token overlaps the call's function tokens.
		const jsonToks = tokens.filter(t => ["property", "jsonString", "number", "boolean"].includes(t.type));
		const fns = tokens.filter(t => t.type === "spruceFunction");
		for (const s of jsonToks) for (const fn of fns) {
			assert.ok(!(s.start < fn.end && fn.start < s.end), `${call}: no JSON token overlaps a function token`);
		}
	}
});

test("json5 block: bare identifier keys highlight as properties", () => {
	const src = `@show({name: "spruce", count: 42})`;
	const tokens = collectTokens(src);
	const typeAt = text => {
		const idx = src.indexOf(text);
		return tokens.find(t => t.start === idx && t.end === idx + text.length)?.type;
	};
	assert.equal(typeAt("name"), "property", "bare key is a property");
	assert.equal(typeAt("count"), "property", "second bare key is a property");
	assert.equal(typeAt("42"), "number", "the value is still a number");
});

test("json5 block: single-quoted strings highlight as keys and values", () => {
	const src = `@show({'k': 'v'})`;
	const tokens = collectTokens(src);
	const typeAt = text => {
		const idx = src.indexOf(text);
		return tokens.find(t => t.start === idx && t.end === idx + text.length)?.type;
	};
	assert.equal(typeAt("'k'"), "property", "single-quoted key is a property");
	assert.equal(typeAt("'v'"), "jsonString", "single-quoted value is a jsonString");
});

test("json5 block: extended number forms (hex, leading point, signs, Infinity/NaN)", () => {
	const src = `@show({a: 0xFF, b: .5, c: +3, d: -Infinity, e: NaN})`;
	const tokens = collectTokens(src);
	const typeAt = text => {
		const idx = src.indexOf(text);
		return tokens.find(t => t.start === idx && t.end === idx + text.length)?.type;
	};
	assert.equal(typeAt("0xFF"), "number", "hex literal");
	assert.equal(typeAt(".5"), "number", "leading-point literal");
	assert.equal(typeAt("+3"), "number", "explicit positive sign");
	assert.equal(typeAt("-Infinity"), "number", "signed Infinity");
	assert.equal(typeAt("NaN"), "number", "bare NaN");
});

test("json5 block: line and block comments highlight as comments", () => {
	const src = `@show({\n\t// a comment\n\tzz: /* inline */ 1,\n})`;
	const tokens = collectTokens(src);
	const slice = text => {
		const idx = src.indexOf(text);
		return tokens.find(t => t.start === idx && t.end === idx + text.length)?.type;
	};
	assert.equal(slice("// a comment"), "comment", "line comment");
	assert.equal(slice("/* inline */"), "comment", "block comment");
	// The scan recovers after the comment: the key and value still tokenize.
	assert.equal(slice("zz"), "property", "key after the comment is still a property");
	assert.equal(slice("1"), "number", "value after the inline comment is still a number");
});

test("json5 block: comment containing an @-call does not overlap the function token", () => {
	const src = `@f({/* @g[x] */ a: 1})`;
	const tokens = collectTokens(src);
	const fns = tokens.filter(t => t.type === "spruceFunction");
	assert.ok(fns.find(t => src.slice(t.start, t.end) === "g"), "nested @g keeps function coloring");
	const comments = tokens.filter(t => t.type === "comment");
	for (const c of comments) for (const f of fns) {
		assert.ok(!(c.start < f.end && f.start < c.end), "no comment token overlaps a function token");
	}
});

test("html in a parsed block still highlights when the closing ]] is indented", () => {
	// The re-matched body ends with the indentation before ]]; that whitespace-only
	// tail used to fail the document re-match, dropping every token in the block.
	const src = "(@f [[\n\t\t<div>\n\t\t<a href=\"/x\">y</a>\n\t]])";
	const strings = collectTokens(src).filter(t => t.type === "string");
	assert.ok(strings.find(t => src.slice(t.start, t.end) === "<div>"), "the <div> tag highlights");
	assert.ok(strings.find(t => src.slice(t.start, t.end) === "<a href=\"/x\">y</a>"), "the <a> tag highlights");
});

test("function call inside a code block is highlighted as a function", () => {
	const src = "```\nlet x = @foo[1]\n```\n";
	const tokens = collectTokens(src);
	const fns = tokens.filter(t => t.type === "spruceFunction");
	const atIdx = src.indexOf("@");
	assert.ok(fns.find(t => t.start === atIdx && t.end === atIdx + 1), "the @ is a function token");
	assert.ok(fns.find(t => src.slice(t.start, t.end) === "foo"), "the name is a function token");
	// Surrounding raw text is still codeBlock-colored, never overlapping a function token.
	const code = tokens.filter(t => t.type === "codeBlock");
	for (const c of code) for (const f of fns) {
		assert.ok(!(c.start < f.end && f.start < c.end), "no overlap between codeBlock and function");
	}
});

test("function call inside inline code is highlighted as a function", () => {
	const src = "`code @bar[2] here`";
	const fns = collectTokens(src).filter(t => t.type === "spruceFunction");
	assert.ok(fns.find(t => src.slice(t.start, t.end) === "bar"));
});

test("function call inside $math$ is highlighted as a function", () => {
	const src = "$x + @f[y]$";
	const fns = collectTokens(src).filter(t => t.type === "spruceFunction");
	assert.ok(fns.find(t => src.slice(t.start, t.end) === "f"));
});

test("parsed block body is highlighted as a full document", () => {
	const src = "@f[[# Heading\n\n**bold** and @g[x]]]";
	const tokens = collectTokens(src);
	// Block-level + inline markup inside the [[ ]] is highlighted.
	assert.ok(tokens.find(t => t.type === "heading" && src.slice(t.start, t.end) === "# Heading"));
	assert.ok(tokens.find(t => t.type === "bold" && src.slice(t.start, t.end) === "bold"));
	// The nested @g function call inside the parsed block is highlighted too.
	const gAt = src.indexOf("@g");
	assert.ok(tokens.find(t => t.type === "spruceFunction" && t.start === gAt));
});

test("nested parsed block inside a parsed block is highlighted recursively", () => {
	const src = "@f[[outer @h[[**deep**]] end]]";
	const tokens = collectTokens(src);
	assert.ok(tokens.find(t => t.type === "bold" && src.slice(t.start, t.end) === "deep"));
});

test("nested brackets @g[@f[x]] pair correctly with sequential colors", () => {
	// The `]]` must split into two closers, each matching its opener — the bug
	// was the pair colorizer treating `]]` as a single (unmatched) token.
	const src = "@g[@f[x]]";
	const brackets = collectTokens(src)
		.filter(t => t.type.startsWith("bracket"))
		.sort((a, b) => a.start - b.start);
	// Outer `[` (idx 2) and outer `]` (idx 8) share a color; inner `[` (5) / `]` (7) share another.
	const outerOpen = brackets.find(t => t.start === 2);
	const innerOpen = brackets.find(t => t.start === 5);
	const innerClose = brackets.find(t => t.start === 7);
	const outerClose = brackets.find(t => t.start === 8);
	// The `]]` splits into two separate closers (idx 7 and 8), each its own token.
	assert.ok(outerOpen && innerOpen && innerClose && outerClose, "all four delimiters colored");
	assert.equal(outerOpen.type, outerClose.type);
	assert.equal(innerOpen.type, innerClose.type);
	// Both calls reset the color, so all four delimiters are yellow (bracket1).
	assert.equal(outerOpen.type, "bracket1");
	assert.equal(innerOpen.type, "bracket1");
});

test("a function call resets the color, so each call's first block is yellow", () => {
	// Each @-call resets the bracket-color sequence, so every call's argument
	// block starts at color1 (yellow) regardless of the preceding calls.
	const src = "@a[x] @b[y] @c[z]";
	const opens = collectTokens(src)
		.filter(t => t.type.startsWith("bracket") && src[t.start] === "[")
		.sort((a, b) => a.start - b.start);
	assert.equal(opens.length, 3);
	assert.equal(opens[0].type, "bracket1");
	assert.equal(opens[1].type, "bracket1");
	assert.equal(opens[2].type, "bracket1");
});

test("adjacent blocks of one call advance, but a nested call resets to yellow", () => {
	// @f[@g[x]][y] -> f's first `[` = color1; the nested @g resets, so @g's `[`
	// is also color1; and f's second `[y]` advances to color2 (adjacent to the
	// first block, no call between them).
	const src = "@f[@g[x]][y]";
	const brackets = collectTokens(src)
		.filter(t => t.type.startsWith("bracket"))
		.sort((a, b) => a.start - b.start);
	// Delimiters in order: [ (f1, idx2), [ (g, idx5), ] (g, idx7), ] (f1, idx8), [ (f2, idx9), ] (f2, idx11)
	const byStart = i => brackets.find(t => t.start === i);
	assert.equal(byStart(2).type, "bracket1"); // f's first [
	assert.equal(byStart(5).type, "bracket1"); // @g's [ (reset by the call)
	assert.equal(byStart(7).type, "bracket1"); // @g's ]
	assert.equal(byStart(8).type, "bracket1"); // f's first ]
	assert.equal(byStart(9).type, "bracket2"); // f's second [ (adjacency advances)
	assert.equal(byStart(11).type, "bracket2"); // f's second ]
});

test("hash-prefixed delimiter is colored as a single unit", () => {
	const src = "@f#[[ inner ]]#";
	const brackets = collectTokens(src).filter(t => t.type.startsWith("bracket"));
	assert.ok(brackets.find(t => src.slice(t.start, t.end) === "#[["));
	assert.ok(brackets.find(t => src.slice(t.start, t.end) === "]]#"));
});

test("list marker `- ` emits a list token", () => {
	const tokens = collectTokens("- item\n");
	const list = tokens.find(t => t.type === "list");
	assert.ok(list);
	assert.equal(list.end - list.start, 1);
});

test("ordered list starter `1.` emits a list token", () => {
	const tokens = collectTokens("1. item\n");
	const list = tokens.find(t => t.type === "list");
	assert.ok(list);
});

test("tokenize returns delta-encoded data array", () => {
	const data = tokenize("# Hi\n");
	assert.ok(Array.isArray(data));
	assert.equal(data.length % 5, 0);
	assert.ok(data.length >= 5);
});

test("failed parse yields empty token list", () => {
	const tokens = collectTokens("unterminated `code");
	assert.deepEqual(tokens, []);
});

test("with no known-names set, a call name stays spruceFunction", () => {
	const tokens = collectTokens("@whatever[x]");
	assert.ok(tokens.find(t => t.type === "spruceFunction"));
	assert.ok(!tokens.find(t => t.type === "undefinedFunction"));
});

test("a call name absent from the known-names set is flagged undefinedFunction", () => {
	const src = "@nope[x]";
	const tokens = collectTokens(src, new Set(["heading"]));
	const name = tokens.find(t => t.type === "undefinedFunction" && src.slice(t.start, t.end) === "nope");
	assert.ok(name, "name flagged undefined");
	// The leading @ stays purple (non-bold) via undefinedFunctionMarker, not red.
	const at = tokens.find(t => t.start === 0 && t.end === 1);
	assert.equal(at.type, "undefinedFunctionMarker", "the @ is the undefined marker color");
	assert.ok(!tokens.find(t => t.type === "spruceFunction"));
	assert.ok(!tokens.find(t => t.type === "invalid"), "nothing is flagged invalid/red");
});

test("a wrapped call to an undefined name paints its parens with the marker color", () => {
	const src = "(@nope[x])";
	const tokens = collectTokens(src, new Set(["heading"]));
	const open = tokens.find(t => t.start === 0 && t.end === 1);
	const close = tokens.find(t => t.start === src.length - 1 && t.end === src.length);
	assert.equal(open.type, "undefinedFunctionMarker", "open paren is the undefined marker color");
	assert.equal(close.type, "undefinedFunctionMarker", "close paren is the undefined marker color");
	// A defined name keeps the parens purple (spruceFunction, bold).
	const ok = collectTokens(src, new Set(["nope"]));
	assert.equal(ok.find(t => t.start === 0 && t.end === 1).type, "spruceFunction");
});

test("a known call name stays spruceFunction even when detection is on", () => {
	const tokens = collectTokens("@ok[x]", new Set(["ok"]));
	assert.ok(tokens.find(t => t.type === "spruceFunction"));
	assert.ok(!tokens.find(t => t.type === "undefinedFunction"));
});

test("an undefined call inside a parsed block keeps a correct absolute offset", () => {
	const src = "[[ @ghost[x] ]]";
	const tok = collectTokens(src, new Set()).find(t => t.type === "undefinedFunction" && src.slice(t.start, t.end) === "ghost");
	assert.ok(tok, "the undefined name keeps its absolute offset inside the block");
	assert.equal(src.slice(tok.start, tok.end), "ghost");
});
