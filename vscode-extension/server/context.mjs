// Which construct the caret sits in, so the client can turn Spruce's markup
// auto-closing pairs (` $ * _) off where those characters aren't parsed. Typing
// `$` in prose should give you `$|$`; typing it in a raw function argument, a
// declaration block or a code block should give you a lone `$`.
//
// Deliberately a lexical scan rather than an Ohm parse, for two reasons. It has
// to answer while the document is being typed — an unterminated ``` fence or a
// half-written @{ block is exactly when the answer matters most, and those don't
// parse — and it has to answer synchronously on the editor's keystroke path,
// where a full re-parse per cursor move would be far too slow. The same tradeoff
// completion.mjs makes for declarationBlocks(), which likewise treats an
// unterminated trailing block as running to the end of the document.
//
// Lives in server/ with the other shared language modules, but it's the *client*
// bundle that consumes it (the language-configuration swap is a VSCode API call,
// and a round trip to the server would land after the keystroke it needs to
// affect).

export const MARKUP = "markup";
export const RAW = "raw";
export const JSON_BLOCK = "json";
export const CODE = "code";
export const MATH = "math";
export const HTML = "html";
export const DECLARATION = "declaration";

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const ALNUM = /[A-Za-z0-9]/;

function isNewline(character) {
	return character === "\n" || character === "\r";
}

// The length of the line break at `i` (2 for CRLF), or 0 if there isn't one.
function newlineLength(text, i) {
	if (text[i] === "\r") return text[i + 1] === "\n" ? 2 : 1;
	return text[i] === "\n" ? 1 : 0;
}

function skipSpaceOrTab(text, i) {
	while (text[i] === " " || text[i] === "\t") i++;
	return i;
}

// The offset just past the line containing `i`, line break included.
function nextLineStart(text, i) {
	while (i < text.length && !isNewline(text[i])) i++;
	return i + newlineLength(text, i);
}

// True when nothing but spaces and tabs remain on the line from `i`.
function restOfLineBlank(text, i) {
	const end = skipSpaceOrTab(text, i);
	return end >= text.length || isNewline(text[end]);
}

// True when a blank line (the grammar's doubleNewline) starts at `i`. Inline
// code and inline math can't span one, so a stray ` or $ gives up there instead
// of swallowing the rest of the document.
function blankLineAt(text, i) {
	const first = newlineLength(text, i);
	if (!first) return false;
	const next = skipSpaceOrTab(text, i + first);
	return next >= text.length || newlineLength(text, next) > 0;
}

// Skips the `#`-run plus the `[[` / `[` / `{` / `(` of a block opener at `i` and
// reports what it opens, or null when no opener starts there. The hashes lead
// the opener (`##[[`) and trail the closer (`]]##`), so the closer is assembled
// from the same run.
function blockOpenerAt(text, i) {
	let j = i;
	while (text[j] === "#") j++;
	const hashes = text.slice(i, j);

	if (text.startsWith("[[", j)) return { length: j + 2 - i, kind: MARKUP, close: `]]${hashes}` };
	if (text[j] === "[") return { length: j + 1 - i, kind: MARKUP, close: `]${hashes}` };
	if (text[j] === "{") return { length: j + 1 - i, kind: RAW, close: `}${hashes}` };
	if (text[j] === "(") return { length: j + 1 - i, kind: JSON_BLOCK, close: `)${hashes}` };
	return null;
}

// True when the enclosing frame's closer starts at `i`. `atLineStart` closers
// (a ``` fence, a $$ display-math fence) only count at the head of a line;
// `newline` closers (an html tag, which runs to end of line) match the line
// break itself and consume none of it.
function closesAt(text, i, frame, atLineHead) {
	const close = frame.close;
	if (!close) return false;
	if (close.newline) return newlineLength(text, i) > 0;
	if (close.atLineStart && !atLineHead) return false;
	return text.startsWith(close.text, i);
}

// The construct containing `offset`: MARKUP wherever Spruce's inline markup is
// live (prose, headings, list items, link text, and the parsed [[ ]] / [ ] block
// bodies), and the matching kind inside anything raw. Positions past the end of
// the text are clamped, so an offset at the very end of a document is fine.
export function contextAt(text, offset) {
	const limit = Math.max(0, Math.min(offset, text.length));
	const stack = [{ kind: MARKUP, close: null }];

	let i = 0;
	// True while nothing but spaces and tabs has been seen since the last line
	// break — i.e. `i` is still at the head of its line, where the grammar's
	// line-anchored constructs (fences, declaration fences, html tags) may start.
	let atLineHead = true;
	// Set after a `@name` call: its argument blocks follow, so the next opener
	// (after any spaces or tabs) belongs to that call rather than to the prose.
	let expectingArguments = false;

	while (i < limit) {
		const top = stack[stack.length - 1];

		// A declaration block's body is plain JS — no escapes, no @-calls, no
		// markup — so skip it a line at a time looking only for its fence.
		if (top.kind === DECLARATION) {
			if (atLineHead && text.startsWith("@@@", i)) {
				// A bare `@@@` line closes the block; a `@@@tag` line closes it and
				// opens the next one (the grammar's soft terminator), so the frame
				// stays and only the opener line is consumed.
				if (restOfLineBlank(text, i + 3)) {
					stack.pop();
					i += 3;
					atLineHead = false;
					continue;
				}
				if (ALNUM.test(text[skipSpaceOrTab(text, i + 3)] ?? "")) {
					i = nextLineStart(text, i);
					atLineHead = true;
					continue;
				}
			}
			i = nextLineStart(text, i);
			atLineHead = true;
			continue;
		}

		// The argument blocks of the call we just passed.
		if (expectingArguments) {
			const start = skipSpaceOrTab(text, i);
			const opener = blockOpenerAt(text, start);
			if (opener) {
				// fromCall so that closing this argument lets the next one open too:
				// `@f[a](b)` is one call with two argument blocks.
				stack.push({ kind: opener.kind, close: { text: opener.close }, fromCall: true });
				i = start + opener.length;
				atLineHead = false;
				expectingArguments = false;
				continue;
			}
			expectingArguments = false;
		}

		// Inline code / inline math give up at a blank line rather than running on.
		if (top.endsAtBlankLine && blankLineAt(text, i)) {
			stack.pop();
			continue;
		}

		if (closesAt(text, i, top, atLineHead)) {
			stack.pop();
			i += top.close.text.length;
			if (top.close.text.length > 0) atLineHead = false;
			if (top.fromCall) expectingArguments = true;
			// `[text](url)`: a link's URL is raw, so it follows the display text
			// straight into a frame of its own.
			if (top.linkText && text[i] === "(") {
				stack.push({ kind: RAW, close: { text: ")" }, endsAtBlankLine: true });
				i += 1;
				atLineHead = false;
			}
			continue;
		}

		// @-calls and escapes are interpreted in every context except a
		// declaration block, raw ones included.
		if (text[i] === "@") {
			if (atLineHead && top.kind === MARKUP && text.startsWith("@@@", i)) {
				let tagEnd = skipSpaceOrTab(text, i + 3);
				while (ALNUM.test(text[tagEnd] ?? "")) tagEnd++;
				if (restOfLineBlank(text, tagEnd)) {
					stack.push({ kind: DECLARATION, close: null });
					i = nextLineStart(text, i);
					atLineHead = true;
					continue;
				}
			}

			const afterAt = skipSpaceOrTab(text, i + 1);

			// `@[...]`, `@[[...]]`, `@{...}`: the identity calls. There's no `@(...)`
			// form — a json block is only ever an argument — so that falls through
			// to the escape below.
			const identity = blockOpenerAt(text, afterAt);
			if (identity && identity.kind !== JSON_BLOCK) {
				stack.push({ kind: identity.kind, close: { text: identity.close } });
				i = afterAt + identity.length;
				atLineHead = false;
				continue;
			}

			if (IDENTIFIER_START.test(text[afterAt] ?? "")) {
				let end = afterAt + 1;
				while (IDENTIFIER_PART.test(text[end] ?? "")) end++;
				i = end;
				atLineHead = false;
				expectingArguments = true;
				continue;
			}

			// `@x` escapes x; a lone `@` before whitespace is the grammar's invalid
			// call, so only the @ itself is consumed.
			const escaped = text[i + 1];
			i += escaped !== undefined && !/\s/.test(escaped) ? 2 : 1;
			atLineHead = false;
			continue;
		}

		if (top.kind === MARKUP) {
			// ``` opens a fenced code block at the head of a line (when nothing but
			// a language tag follows) and inline code anywhere else.
			if (atLineHead && text.startsWith("```", i)) {
				let tagEnd = skipSpaceOrTab(text, i + 3);
				while (ALNUM.test(text[tagEnd] ?? "")) tagEnd++;
				if (restOfLineBlank(text, tagEnd)) {
					stack.push({ kind: CODE, close: { text: "```", atLineStart: true } });
					i += 3;
					atLineHead = false;
					continue;
				}
			}

			if (text[i] === "`") {
				stack.push({ kind: CODE, close: { text: "`" }, endsAtBlankLine: true });
				i += 1;
				atLineHead = false;
				continue;
			}

			// $$ alone on a line opens a display-math block; otherwise it's inline
			// display math, and a single $ is inline math.
			if (text.startsWith("$$", i)) {
				const fenced = atLineHead && restOfLineBlank(text, i + 2);
				stack.push(fenced
					? { kind: MATH, close: { text: "$$", atLineStart: true } }
					: { kind: MATH, close: { text: "$$" }, endsAtBlankLine: true });
				i += 2;
				atLineHead = false;
				continue;
			}

			if (text[i] === "$") {
				stack.push({ kind: MATH, close: { text: "$" }, endsAtBlankLine: true });
				i += 1;
				atLineHead = false;
				continue;
			}

			// A raw html tag runs to the end of its line.
			if (atLineHead && text[i] === "<") {
				stack.push({ kind: HTML, close: { text: "", newline: true } });
				i += 1;
				atLineHead = false;
				continue;
			}

			// A link's display text. Prose can't hold a bare [ ] pair (the grammar
			// makes those escapes), so every [ here opens a bracketed span, and its
			// content is markup either way.
			if (text[i] === "[") {
				stack.push({ kind: MARKUP, close: { text: "]" }, linkText: true });
				i += 1;
				atLineHead = false;
				continue;
			}
		}

		const newline = newlineLength(text, i);
		if (newline) {
			i += newline;
			atLineHead = true;
			continue;
		}

		if (text[i] !== " " && text[i] !== "\t") atLineHead = false;
		i += 1;
	}

	return stack[stack.length - 1].kind;
}
