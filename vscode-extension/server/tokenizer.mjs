// spruce.js (and its stdlib.js dependency) live at the repo root, outside this
// extension folder, so vsce can't package them from there. build-and-install.sh
// vendors fresh copies into server/ before packaging; the dev host relies on the
// same copies. Run that script once after cloning so these exist.
import { grammarFor } from "./spruce.js";

export const TOKEN_TYPES = [
	"heading",
	"bold",
	"italic",
	"boldItalic",
	"inlineCode",
	"codeBlock",
	"list",
	"spruceFunction",
	"undefinedFunction",
	"undefinedFunctionMarker",
	"escape",
	"invalid",
	"string",
	"linkText",
	"operator",
	"namespace",
	"marker",
	"languageTag",
	"bracket1",
	"bracket2",
	"bracket3",
	"property",
	"jsonString",
	"number",
	"boolean",
	"comment",
];

// Bold/italic are token *modifiers*, not types: they compose with whatever type
// a span already has (a bold link stays `linkText` green and additionally gains
// the bold style) instead of replacing it. LSP tokens can't overlap, so we can't
// layer a separate "bold" token over a link — the styling has to ride along on
// the link's own token as a modifier bit.
export const TOKEN_MODIFIERS = ["bold", "italic"];

const typeIndex = Object.fromEntries(TOKEN_TYPES.map((t, i) => [t, i]));
const modifierIndex = Object.fromEntries(TOKEN_MODIFIERS.map((m, i) => [m, i]));
const MOD_BOLD = 1 << modifierIndex.bold;
const MOD_ITALIC = 1 << modifierIndex.italic;

// Bold/italic nest (e.g. `**a *b* c**`), and the inner span should carry both
// modifiers. We thread the active set down through recursion: emitting a token
// stamps it with whatever modifiers are in scope, and entering a bold/italic
// span ORs in its bit for the duration of its children. Module scope because
// emit() (called from deep in the tree) needs to read it. Reset per document.
let activeModifiers = 0;

// Bracket-pair colorization. The color advances both with nesting depth and
// between adjacent same-depth blocks, but a block's own nesting doesn't bleed
// into its parent's sibling sequence. So instead of one global running counter,
// each nesting level has its own counter: `bracketColorCounter` holds the color
// for the next bracket opened at the current level. Opening a block colors it
// with that value; its children start one past it (deeper = next color); and
// once the block closes the level resets so the next sibling also lands one past
// the block (adjacent = next color). e.g. `@f[@g[x]][y]` -> f=1, g=2, y=2.
// Module scope because parsedBlock re-matches its body through a fresh collect
// (see below) and the colors must flow across that boundary. Reset per document
// in collectTokens.
const BRACKET_COLORS = 2;
let bracketColorCounter = 0;
function bracketType(color) {
	return `bracket${(color % BRACKET_COLORS) + 1}`;
}

// Emit the opening/closing delimiter terminals of a bracketed node, running
// `collectBody` (which descends into the body) in between. Children are colored
// one past this block; afterwards the level is reset so the next sibling is too.
// `delimiterType` overrides the color of the delimiters themselves (used by
// wrapped function calls to paint their parens like the function name) while
// leaving the inner/sibling bracket-color sequencing untouched.
function emitBracketed(node, t, collectBody, delimiterType) {
	const open = node.children[0];
	const close = node.children[node.children.length - 1];
	const color = bracketColorCounter;
	const type = delimiterType ?? bracketType(color);
	emit(t, open.source.startIdx, open.source.endIdx, type);
	bracketColorCounter = color + 1;
	collectBody();
	bracketColorCounter = color + 1;
	emit(t, close.source.startIdx, close.source.endIdx, type);
}

// Raw environments (code blocks, inline code, math, @{} raw blocks) render their
// content as a single flat color, EXCEPT for nested @function calls, which the
// compiler still interprets and which therefore stay purple+bold like in parsed
// content. We let the body's children emit their own tokens first (so nested
// @funcs keep their function coloring), then — when `fillType` is given — paint
// the leftover gaps with that raw color. Math passes no `fillType` so its body
// stays under the embedded LaTeX grammar; only the @funcs get semantic tokens.
//
// The raw fill is suppressed *inside* nested @function-call spans: a call's
// argument may be a parsedBlock, whose body is parsed (markdown) content, so its
// plain text must stay default-colored rather than picking up the raw color. We
// treat each top-level call as an opaque region the fill skips over; the tokens
// emitted within it (function name, brackets, and any nested markup) stand alone.
function emitRawBody(t, bodyNode, start, end, fillType) {
	const inner = [];
	bodyNode.collect(inner);
	inner.sort((a, b) => a.start - b.start);
	if (fillType) {
		const callSpans = [];
		collectCallSpans(bodyNode, callSpans);
		let cursor = start;
		for (const tok of inner) {
			if (tok.start > cursor) fillOutsideCalls(t, cursor, tok.start, fillType, callSpans);
			if (tok.end > cursor) cursor = tok.end;
		}
		if (cursor < end) fillOutsideCalls(t, cursor, end, fillType, callSpans);
	}
	for (const tok of inner) t.push(tok);
}

// Collect the source spans of the outermost @function calls under `node`, in
// source order. We stop descending at each call so the span covers the whole
// call (including any parsed-block argument) as one opaque region.
function collectCallSpans(node, spans) {
	if (typeof node.ctorName === "string" && node.ctorName.startsWith("functionCall")) {
		spans.push({ start: node.source.startIdx, end: node.source.endIdx });
		return;
	}
	for (const c of node.children) collectCallSpans(c, spans);
}

// Collect the outermost @function-call nodes under `node`, in source order.
// Like collectCallSpans, but keeps the nodes themselves so their tokens can be
// re-collected (used to surface @-calls inside otherwise flat-colored spans).
function collectCallNodes(node, nodes) {
	if (typeof node.ctorName === "string" && node.ctorName.startsWith("functionCall")) {
		nodes.push(node);
		return;
	}
	for (const c of node.children) collectCallNodes(c, nodes);
}

// Paint [start, end) with `fillType`, except for nested @function calls, which
// keep their own (purple) function coloring. Used by environments whose body is
// otherwise a single flat color but still interprets @-calls — headings and a
// link's display text / URL. Mirrors emitRawBody, but fills the whole range
// rather than only the gaps a raw grammar leaves untokenized.
function emitFillWithCalls(t, node, start, end, fillType) {
	const callNodes = [];
	collectCallNodes(node, callNodes);
	const callSpans = callNodes.map(n => ({ start: n.source.startIdx, end: n.source.endIdx }));
	callSpans.sort((a, b) => a.start - b.start);
	fillOutsideCalls(t, start, end, fillType, callSpans);
	for (const n of callNodes) n.collect(t);
}

// Emit `fillType` over [a, b), skipping any sub-range that lies within a call
// span (those regions are interpreted, not raw). `callSpans` is sorted by start.
function fillOutsideCalls(t, a, b, fillType, callSpans) {
	let cursor = a;
	for (const span of callSpans) {
		if (span.end <= cursor) continue;
		if (span.start >= b) break;
		if (span.start > cursor) emit(t, cursor, span.start, fillType);
		if (span.end > cursor) cursor = span.end;
	}
	if (cursor < b) emit(t, cursor, b, fillType);
}

// Emits JSON5 syntax-highlighting tokens for a json-block body, matching the
// editor's default JSON colors as closely as we can: property keys (quoted or
// bare identifiers), string values (single- or double-quoted), numbers, and the
// keyword constants (true/false/null/Infinity/NaN) each get their own scope
// (mapped to the standard JSON TextMate scopes in package.json), comments take
// the comment scope, and braces/brackets take the sequential bracket-pair colors,
// continuing one level deeper than the block's own parens (`baseColor`). Nested
// @function calls — which the compiler still interprets — keep their function
// coloring: we collect their tokens first and treat each as an opaque span the
// scan skips over, so e.g. an @-call inside a string value doesn't derail it.
function emitJsonBody(t, bodyNode, start, end, baseColor) {
	const text = bodyNode.source.sourceString;
	// The tokens nested @-calls emit (the @, name, brackets, recursed content) —
	// pushed as-is so each call keeps its own coloring.
	const callTokens = [];
	bodyNode.collect(callTokens);
	// The *whole-call* spans (each call as one opaque region, gaps included) — what
	// the JSON scan skips over. Distinct from callTokens: a call like @[hi] emits
	// tokens only for @ [ ], leaving "hi" un-tokenized, but the scan must still treat
	// the entire @[hi] as one unit so a string/comment fill doesn't paint into it and
	// its inner text isn't mis-scanned as JSON. Mirrors emitRawBody's approach.
	const callSpans = [];
	collectCallSpans(bodyNode, callSpans);
	callSpans.sort((a, b) => a.start - b.start);
	scanJson(t, text, start, end, callSpans, baseColor);
	for (const tok of callTokens) t.push(tok);
}

// The nested @-call span covering offset `i`, if any (so the JSON scan can skip
// over it). Spans are small and few per block, so a linear probe is fine.
function callAt(calls, i) {
	for (const c of calls) if (c.start <= i && i < c.end) return c;
	return null;
}

function scanJson(t, text, start, end, calls, baseColor) {
	let i = start;
	let depth = 0;
	while (i < end) {
		const span = callAt(calls, i);
		if (span) { i = span.end; continue; }
		const c = text[i];
		if (c === "{" || c === "[") {
			emit(t, i, i + 1, bracketType(baseColor + depth));
			depth++;
			i++;
		} else if (c === "}" || c === "]") {
			if (depth > 0) depth--;
			emit(t, i, i + 1, bracketType(baseColor + depth));
			i++;
		} else if (c === '"' || c === "'") {
			// JSON5 allows single- or double-quoted strings.
			const strEnd = scanJsonString(text, i, end, calls, c);
			// A string is a property key iff the next significant char is a colon.
			const isKey = nextSignificant(text, strEnd, end, calls) === ":";
			// Paint the string around any nested @-call span (like comments do) so the
			// string token never overlaps the call's own function tokens.
			fillOutsideCalls(t, i, Math.min(strEnd, end), isKey ? "property" : "jsonString", calls);
			i = strEnd;
		} else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
			// JSON5 line (`//`) and block (`/* */`) comments. Painted around any
			// nested @-call span so a comment token never overlaps a function token.
			const cmtEnd = scanComment(text, i, end);
			fillOutsideCalls(t, i, cmtEnd, "comment", calls);
			i = cmtEnd;
		} else if (isNumberStart(text, i, end)) {
			const numEnd = scanJsonNumber(text, i, end);
			emit(t, i, numEnd, "number");
			i = numEnd;
		} else if (isIdentStart(c)) {
			// A bare identifier is a JSON5 property key (when followed by `:`); the
			// only bare words valid as values are the keyword constants below.
			let j = i + 1;
			while (j < end && isIdentPart(text[j])) j++;
			const word = text.slice(i, j);
			if (nextSignificant(text, j, end, calls) === ":") emit(t, i, j, "property");
			else if (word === "true" || word === "false" || word === "null") emit(t, i, j, "boolean");
			else if (word === "Infinity" || word === "NaN") emit(t, i, j, "number");
			i = j;
		} else {
			// Whitespace, ':' and ',' (default-colored), or stray characters.
			i++;
		}
	}
}

// JSON5 identifier-name characters (an approximation of the ECMAScript rules,
// covering the ASCII set documents actually use for keys).
function isIdentStart(c) {
	return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}
function isIdentPart(c) {
	return isIdentStart(c) || (c >= "0" && c <= "9");
}

// True if a number literal begins at `i`: a digit, a `.`/sign before a digit, or
// a sign before `Infinity`/`NaN` (e.g. `-Infinity`). Bare `Infinity`/`NaN` start
// with a letter, so they fall to the identifier branch instead.
function isNumberStart(text, i, end) {
	const c = text[i];
	if (c >= "0" && c <= "9") return true;
	const d = text[i + 1];
	if (c === ".") return d >= "0" && d <= "9";
	if (c === "+" || c === "-") return (d >= "0" && d <= "9") || d === "." || d === "I" || d === "N";
	return false;
}

// Scans a `//` line comment or `/* */` block comment from `i`; returns the offset
// just past it (or `end` if a block comment is unterminated).
function scanComment(text, i, end) {
	if (text[i + 1] === "/") {
		let j = i + 2;
		while (j < end && text[j] !== "\n" && text[j] !== "\r") j++;
		return j;
	}
	let j = i + 2;
	while (j < end && !(text[j] === "*" && text[j + 1] === "/")) j++;
	return Math.min(j + 2, end);
}

// Scans a string starting at the opening quote `i` (`quote` is `"` or `'`);
// returns the offset just past the matching closing quote (or `end` if
// unterminated). Skips backslash escapes (including line continuations) and any
// nested @-call span (an @-call may sit inside the string literal).
function scanJsonString(text, i, end, calls, quote) {
	let j = i + 1;
	while (j < end) {
		const span = callAt(calls, j);
		if (span) { j = span.end; continue; }
		const ch = text[j];
		if (ch === "\\") { j += 2; continue; }
		if (ch === quote) return j + 1;
		j++;
	}
	return end;
}

// The next non-whitespace character at or after `from`, skipping @-call spans, or
// null at end. Used to tell a `"key":` from a bare string value.
function nextSignificant(text, from, end, calls) {
	let j = from;
	while (j < end) {
		const span = callAt(calls, j);
		if (span) { j = span.end; continue; }
		const ch = text[j];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { j++; continue; }
		return ch;
	}
	return null;
}

// Scans a JSON5 number from `i`: an optional sign, then `Infinity`/`NaN`, a hex
// literal (`0x...`), or a decimal with optional leading/trailing point and
// exponent (`.5`, `5.`, `1e3`).
function scanJsonNumber(text, i, end) {
	let j = i;
	if (text[j] === "+" || text[j] === "-") j++;
	if (text.startsWith("Infinity", j)) return j + 8;
	if (text.startsWith("NaN", j)) return j + 3;
	if (text[j] === "0" && (text[j + 1] === "x" || text[j + 1] === "X")) {
		j += 2;
		while (j < end && /[0-9a-fA-F]/.test(text[j])) j++;
		return j;
	}
	while (j < end && text[j] >= "0" && text[j] <= "9") j++;
	if (text[j] === ".") { j++; while (j < end && text[j] >= "0" && text[j] <= "9") j++; }
	if (text[j] === "e" || text[j] === "E") {
		j++;
		if (text[j] === "+" || text[j] === "-") j++;
		while (j < end && text[j] >= "0" && text[j] <= "9") j++;
	}
	return j;
}

// True when a call's function name resolves to nothing — used to paint the @
// (and a wrapped call's parens) with undefinedFunctionMarker, the same purple as
// a real call but non-bold, matching the undefinedFunction name token.
// Returns false when detection is off (no known-names set) or there's no name
// (e.g. a raw @{} call). The name is the identifier right after the @.
function callNameUndefined(node) {
	if (!currentKnownNames) return false;
	const m = /@[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(node.sourceString);
	return m ? !currentKnownNames.has(m[1]) : false;
}

// Rule handlers. Returning true means "fully handled, don't recurse into children";
// returning undefined falls through to recursing into all children.
const handlers = {
	heading(node, t) {
		// The heading is one flat color, but nested @funcs (which the compiler
		// still interprets) keep their purple function coloring.
		emitFillWithCalls(t, node, node.source.startIdx, node.source.endIdx, "heading");
		return true;
	},

	bold(node, t) {
		emitStyledSpan(t, node, 2, "bold", MOD_BOLD);
		return true;
	},

	italic(node, t) {
		emitStyledSpan(t, node, 1, "italic", MOD_ITALIC);
		return true;
	},

	boldItalic(node, t) {
		emitStyledSpan(t, node, 3, "boldItalic", MOD_BOLD | MOD_ITALIC);
		return true;
	},

	code(node, t) {
		// Backticks share the light-blue raw color (string), not the gray
		// marker color used for *_ delimiters. The body is raw, but nested @funcs
		// (which the compiler still interprets) keep their function coloring.
		const s = node.source.startIdx;
		const e = node.source.endIdx;
		emit(t, s, s + 1, "string");
		emitRawBody(t, node.children[1], s + 1, e - 1, "inlineCode");
		emit(t, e - 1, e, "string");
		return true;
	},

	codeBlock(node, t) {
		const text = node.source.contents;
		const s = node.source.startIdx;
		const openIdx = text.indexOf("```");
		const closeIdx = text.lastIndexOf("```");
		if (openIdx < 0 || closeIdx <= openIdx) {
			emit(t, s, node.source.endIdx, "codeBlock");
			return true;
		}
		// Find the optional language tag: alnum* after ``` and optional whitespace.
		let i = openIdx + 3;
		while (text[i] === " " || text[i] === "\t") i++;
		const langStart = i;
		while (i < text.length && /[A-Za-z0-9]/.test(text[i])) i++;
		const langEnd = i;

		emit(t, s + openIdx, s + openIdx + 3, "string");
		if (langEnd > langStart) emit(t, s + langStart, s + langEnd, "languageTag");
		// The body is raw, but nested @funcs keep their function coloring.
		emitRawBody(t, node.children[6], s + langEnd, s + closeIdx, "codeBlock");
		emit(t, s + closeIdx, s + closeIdx + 3, "string");
		return true;
	},

	// Math content is handled by the embedded LaTeX TextMate grammar, but we
	// still emit semantic tokens for the $ / $$ delimiters so they pick up the
	// light-blue raw color (overriding the gray TextMate fallback).
	math(node, t) {
		const s = node.source.startIdx;
		const e = node.source.endIdx;
		emit(t, s, s + 1, "string");
		// No fill type: leave the body to the embedded LaTeX grammar, but still
		// surface any nested @funcs (which the compiler interprets) as functions.
		emitRawBody(t, node.children[1], s + 1, e - 1, null);
		emit(t, e - 1, e, "string");
		return true;
	},
	inlineDisplayMath(node, t) {
		const s = node.source.startIdx;
		const e = node.source.endIdx;
		emit(t, s, s + 2, "string");
		emitRawBody(t, node.children[1], s + 2, e - 2, null);
		emit(t, e - 2, e, "string");
		return true;
	},
	displayMath(node, t) {
		const text = node.source.contents;
		const s = node.source.startIdx;
		const openIdx = text.indexOf("$$");
		const closeIdx = text.lastIndexOf("$$");
		if (openIdx < 0 || closeIdx <= openIdx) return true;
		emit(t, s + openIdx, s + openIdx + 2, "string");
		// No fill type: the body stays under the embedded LaTeX grammar; only
		// nested @funcs get semantic tokens.
		emitRawBody(t, node.children[4], s + openIdx + 2, s + closeIdx, null);
		emit(t, s + closeIdx, s + closeIdx + 2, "string");
		return true;
	},
	declarationBlock(_node, _t) { return true; },

	link(node, t) {
		const text = node.source.contents;
		const closeBracket = text.indexOf("](");
		if (closeBracket < 0) return;
		const s = node.source.startIdx;
		const e = node.source.endIdx;
		emit(t, s, s + 1, "operator");
		emit(t, s + closeBracket, s + closeBracket + 2, "operator");
		emit(t, e - 1, e, "operator");
		// Display text `[...]` is green (linkText); the URL `(...)` stays string.
		// Both still interpret nested @funcs, which keep their purple coloring.
		emitFillWithCalls(t, node.children[1], s + 1, s + closeBracket, "linkText");
		emitFillWithCalls(t, node.children[4], s + closeBracket + 2, e - 1, "string");
		return true;
	},

	// `(@name[...])` — the wrapping parens are painted like the function name
	// (spruceFunction) rather than as a bracket pair, but inner blocks still take
	// sequential bracket colors, so we take over recursion to interleave
	// open-paren / @ / body / close-paren correctly.
	functionCall_wrapped(node, t) {
		// When the wrapped call's name is undefined, the @ *and* the wrapping parens
		// take undefinedFunctionMarker — the same purple as a real call, but non-bold.
		// The name itself takes the distinct `undefinedFunction` type so the server
		// raises exactly one error diagnostic per call (off the name), not one per
		// marker token; both render the same color.
		const callType = callNameUndefined(node) ? "undefinedFunctionMarker" : "spruceFunction";
		emitBracketed(node, t, () => {
			const atOffset = node.source.contents.indexOf("@");
			if (atOffset >= 0) {
				const s = node.source.startIdx + atOffset;
				emit(t, s, s + 1, callType);
			}
			// A function call resets the bracket-color sequence: its first argument
			// block (the next delimiter after the call) is always yellow.
			bracketColorCounter = 0;
			for (const c of node.children) c.collect(t);
		}, callType);
		return true;
	},
	functionCall_bare(node, t) {
		// The @ takes undefinedFunctionMarker (purple, non-bold) along with the name
		// when the call is to an undefined name; the name token alone carries
		// `undefinedFunction` so the server raises just one diagnostic per call.
		const callType = callNameUndefined(node) ? "undefinedFunctionMarker" : "spruceFunction";
		emit(t, node.source.startIdx, node.source.startIdx + 1, callType);
		// Reset so the first argument block after the call is yellow (see wrapped).
		bracketColorCounter = 0;
		for (const c of node.children) c.collect(t);
		return true;
	},
	functionCall_raw(node, t) {
		emit(t, node.source.startIdx, node.source.startIdx + 1, "spruceFunction");
		// Reset so the first argument block after the call is yellow (see wrapped).
		bracketColorCounter = 0;
		for (const c of node.children) c.collect(t);
		return true;
	},
	// @[[...]] / @[...] — identity calls on a parsed / inline block. Colored like
	// @{...}: the @ is the function marker and the block (the lone "argument")
	// recurses, so its delimiters and content highlight normally.
	functionCall_parsed(node, t) {
		emit(t, node.source.startIdx, node.source.startIdx + 1, "spruceFunction");
		bracketColorCounter = 0;
		for (const c of node.children) c.collect(t);
		return true;
	},
	functionCall_inline(node, t) {
		emit(t, node.source.startIdx, node.source.startIdx + 1, "spruceFunction");
		bracketColorCounter = 0;
		for (const c of node.children) c.collect(t);
		return true;
	},
	// Escape sequences (@] @} @@ etc.): both the escaping @ and the escaped
	// character take the light-orange escape color, so the whole 2-char sequence
	// reads as one escape unit.
	functionCall_escaped(node, t) {
		emit(t, node.source.startIdx, node.source.endIdx, "escape");
		return true;
	},

	// A bare @ that isn't a valid call (e.g. "@" followed by a space): the
	// compiler rejects it, so flag the whole sequence as invalid. Matched inside
	// raw blocks too (functionCall is part of the raw grammar), so it surfaces in
	// both parsed and raw contexts.
	functionCall_invalid(node, t) {
		emit(t, node.source.startIdx, node.source.endIdx, "invalid");
		return true;
	},

	// A function-call name. When the document's in-scope names are known (the
	// server passes them; tests calling collectTokens(text) alone don't), a name
	// that resolves to nothing — not a stdlib reserved, not defined or imported in
	// the document — is flagged `undefinedFunction` (red, like an invalid @, and
	// surfaced as an error diagnostic by the server) instead of spruceFunction.
	jsIdentifier(node, t) {
		const type = currentKnownNames && !currentKnownNames.has(node.sourceString)
			? "undefinedFunction"
			: "spruceFunction";
		emit(t, node.source.startIdx, node.source.endIdx, type);
		return true;
	},

	// Parsed blocks (`[[ ... ]]`, optionally hash-prefixed) contain a full
	// sub-document — at compile time the body is re-matched against the `document`
	// rule (see spruce.js). The grammar treats the body as raw `any` here, so to
	// highlight the markup inside (headings, bold, nested @funcs, ...) we re-match
	// it ourselves and splice the resulting tokens back at the body's offset. The
	// `[[` / `]]` (and any hashes) delimiters take sequential bracket colors.
	parsedBlock(node, t) {
		emitBracketed(node, t, () => {
			const body = node.children[1];
			const offset = body.source.startIdx;
			const match = activeGrammar.match(body.sourceString, "document");
			if (match.succeeded()) {
				const inner = [];
				semanticsFor(activeGrammar)(match).collect(inner);
				// Preserve modifiers computed inside the re-matched sub-document
				// (e.g. **bold** within the block) and add any ambient ones.
				for (const tok of inner) {
					emitWith(t, tok.start + offset, tok.end + offset, tok.type, tok.modifiers | activeModifiers);
				}
			}
		});
		return true;
	},

	// Inline parsed blocks (`[ ... ]`, optionally hash-prefixed) are parsed
	// directly (no re-match), so their body subtree can recurse normally. The
	// `[` / `]` delimiters take sequential bracket colors.
	parsedInlineBlock(node, t) {
		emitBracketed(node, t, () => node.children[1].collect(t));
		return true;
	},

	// Raw blocks: the content is a string, EXCEPT for nested function calls,
	// which keep their own coloring. We let children emit their tokens first
	// (so nested @funcs render as functions), then fill the gaps with `string`.
	// The `{` / `}` (and any hashes) delimiters take sequential bracket colors.
	rawBlock(node, t) {
		emitBracketed(node, t, () => {
			const body = node.children[1];
			emitRawBody(t, body, body.source.startIdx, body.source.endIdx, "string");
		});
		return true;
	},

	// JSON blocks (`( ... )`, optionally hash-prefixed) are raw JSON5 text fed to
	// JSON5.parse. The `(` / `)` delimiters take sequential bracket colors; the body
	// gets JSON5 syntax highlighting (see emitJsonBody), with the braces/brackets
	// continuing the bracket-color sequence one level inside the parens.
	jsonBlock(node, t) {
		emitBracketed(node, t, () => {
			const body = node.children[1];
			emitJsonBody(t, body, body.source.startIdx, body.source.endIdx, bracketColorCounter);
		});
		return true;
	},

	orderedItemStarter_numeric(node, t) {
		emit(t, node.source.startIdx, node.source.endIdx, "list");
		return true;
	},
	orderedItemStarter_plus(node, t) {
		emit(t, node.source.startIdx, node.source.endIdx, "list");
		return true;
	},

	unorderedItem(node, t) {
		const offset = node.source.contents.indexOf("-");
		if (offset >= 0) {
			const s = node.source.startIdx + offset;
			emit(t, s, s + 1, "list");
		}
	},

	// Raw HTML tags (`<div>`, `</p>`, ...) get the light-blue raw color (string),
	// EXCEPT for nested @funcs (which the compiler interprets) — those keep their
	// function coloring, like any other raw environment. The rule allows leading
	// whitespace, so start at the `<` so indentation isn't colored. The body is
	// children[2] (after the optional whitespace and the `<`).
	htmlTag(node, t) {
		const offset = node.source.contents.indexOf("<");
		if (offset < 0) return true;
		const start = node.source.startIdx + offset;
		emitRawBody(t, node.children[2], start, node.source.endIdx, "string");
		return true;
	},
};

function emit(tokens, start, end, type) {
	if (end > start) tokens.push({ start, end, type, modifiers: activeModifiers });
}

// Like emit, but with an explicit modifier set instead of the ambient one.
function emitWith(tokens, start, end, type, modifiers) {
	if (end > start) tokens.push({ start, end, type, modifiers });
}

// Emit a bold/italic span: `marker` tokens for the first/last `markerLen`
// delimiter chars, then recurse into the content so nested constructs (links,
// code, @funcs, nested emphasis) keep their own colors — only OR-ing in `modBit`
// so they additionally render bold/italic. Plain text not claimed by any child
// token is filled with `contentType` (also carrying the modifier). Children and
// gap-fillers stay non-overlapping, as LSP semantic tokens require.
function emitStyledSpan(tokens, node, markerLen, contentType, modBit) {
	const s = node.source.startIdx;
	const e = node.source.endIdx;
	const contentStart = s + markerLen;
	const contentEnd = e - markerLen;
	emit(tokens, s, contentStart, "marker");
	emit(tokens, contentEnd, e, "marker");

	const prev = activeModifiers;
	activeModifiers = prev | modBit;
	const inner = [];
	for (const c of node.children) c.collect(inner);
	activeModifiers = prev;

	inner.sort((a, b) => a.start - b.start);
	let cursor = contentStart;
	for (const tok of inner) {
		if (tok.start > cursor) emitWith(tokens, cursor, tok.start, contentType, prev | modBit);
		if (tok.end > cursor) cursor = tok.end;
	}
	if (cursor < contentEnd) emitWith(tokens, cursor, contentEnd, contentType, prev | modBit);
	for (const tok of inner) tokens.push(tok);
}

const collectOperation = {
	_terminal() {},
	_iter(...children) {
		for (const c of children) c.collect(this.args.tokens);
	},
	_nonterminal(...children) {
		const handler = handlers[this.ctorName];
		const stop = handler && handler(this, this.args.tokens);
		if (stop) return;
		for (const c of children) c.collect(this.args.tokens);
	},
};

// The grammar is built on demand per input (its hash depth varies), so cache one
// semantics per grammar instance rather than creating it once at module load.
const semanticsCache = new WeakMap();

function semanticsFor(grammar) {
	let semantics = semanticsCache.get(grammar);
	if (!semantics) {
		semantics = grammar.createSemantics();
		semantics.addOperation("collect(tokens)", collectOperation);
		semanticsCache.set(grammar, semantics);
	}
	return semantics;
}

// The grammar that can parse the document currently being tokenized. Held at
// module scope so the parsedBlock handler can re-match block bodies against it.
let activeGrammar = null;

// The set of names that resolve in the current document (stdlib reserved names
// plus whatever it defines or imports), or null to skip undefined-function
// detection. Module scope so the jsIdentifier handler — reached deep in the
// tree, including inside re-matched parsed blocks — can consult it. Reset per
// document in collectTokens.
let currentKnownNames = null;

export function collectTokens(text, knownNames = null) {
	const grammar = grammarFor(text);
	activeGrammar = grammar;
	const match = grammar.match(text);
	if (match.failed()) return [];
	bracketColorCounter = 0;
	activeModifiers = 0;
	currentKnownNames = knownNames;
	const tokens = [];
	semanticsFor(grammar)(match).collect(tokens);
	currentKnownNames = null;
	return tokens;
}

export function encodeTokens(text, tokens) {
	const lineStarts = computeLineStarts(text);
	const flat = [];
	for (const tok of tokens) splitByLine(tok, lineStarts, text, flat);
	flat.sort((a, b) => a.line - b.line || a.char - b.char);

	const filtered = [];
	let lastLine = -1, lastEnd = -1;
	for (const tok of flat) {
		if (tok.line === lastLine && tok.char < lastEnd) continue;
		filtered.push(tok);
		lastLine = tok.line;
		lastEnd = tok.char + tok.length;
	}

	const data = [];
	let prevLine = 0, prevChar = 0;
	for (const tok of filtered) {
		const deltaLine = tok.line - prevLine;
		const deltaChar = deltaLine === 0 ? tok.char - prevChar : tok.char;
		data.push(deltaLine, deltaChar, tok.length, typeIndex[tok.type], tok.modifiers | 0);
		prevLine = tok.line;
		prevChar = tok.char;
	}
	return data;
}

function computeLineStarts(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 10) starts.push(i + 1);
		else if (ch === 13) {
			if (text.charCodeAt(i + 1) === 10) i++;
			starts.push(i + 1);
		}
	}
	return starts;
}

function offsetToLineChar(offset, lineStarts) {
	let lo = 0, hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo, char: offset - lineStarts[lo] };
}

function splitByLine(tok, lineStarts, text, out) {
	const mod = tok.modifiers | 0;
	const startPos = offsetToLineChar(tok.start, lineStarts);
	const endPos = offsetToLineChar(tok.end, lineStarts);
	if (startPos.line === endPos.line) {
		const length = endPos.char - startPos.char;
		if (length > 0) out.push({ line: startPos.line, char: startPos.char, length, type: tok.type, modifiers: mod });
		return;
	}
	const firstLineEnd = lineEndOffset(text, lineStarts, startPos.line);
	const firstLen = firstLineEnd - tok.start;
	if (firstLen > 0) out.push({ line: startPos.line, char: startPos.char, length: firstLen, type: tok.type, modifiers: mod });
	for (let l = startPos.line + 1; l < endPos.line; l++) {
		const len = lineEndOffset(text, lineStarts, l) - lineStarts[l];
		if (len > 0) out.push({ line: l, char: 0, length: len, type: tok.type, modifiers: mod });
	}
	if (endPos.char > 0) out.push({ line: endPos.line, char: 0, length: endPos.char, type: tok.type, modifiers: mod });
}

function lineEndOffset(text, lineStarts, line) {
	const nextStart = line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length;
	let end = nextStart;
	while (end > lineStarts[line] && (text.charCodeAt(end - 1) === 10 || text.charCodeAt(end - 1) === 13)) end--;
	return end;
}

export function tokenize(text, knownNames = null) {
	return encodeTokens(text, collectTokens(text, knownNames));
}
