#!/usr/bin/env node
import { randomUUID } from "crypto";
import { realpathSync, unlinkSync } from "fs";
import { readFile, unlink, writeFile } from "fs/promises";
import JSON5 from "json5";
import * as ohm from "ohm-js";
import { dirname, extname, join, resolve as resolvePath } from "path";
import process from "process";
import { pathToFileURL } from "url";
import { stdlib } from "./stdlib.js";

const pendingCleanup = new Set();

const bt = "`";

// Named stdlib functions that aren't callable inline as @name[...]. After the
// body is fully assembled, each is invoked in order on the running result, so
// the value compile returns is `lastHook(...firstHook(body)...)`. To add
// another whole-document transform, append its name here and provide a
// matching function on the format's stdlib entry.
const POST_COMPILE_HOOKS = ["document"];

// Reserved property on __spruceOutput where the generated module stashes any
// declaration-block binding (declared or imported) that shadows a post-compile
// hook. These hooks run on the host *after* the module, so unlike inline
// @-calls they can't be shadowed from module scope directly — we ferry the
// override out so the host can prefer it over the stdlib default.
const HOOK_OVERRIDES_KEY = "__spruceHookOverrides";

// The parsed/inline/raw block delimiters can be prefixed with any number of
// hashes (`#[[`, `##[[`, `###[[`, ...) to nest blocks past inner closers. Rather
// than hardcode a fixed ceiling, we scan each input for the deepest hash run that
// actually appears (see maxHashDepth) and generate exactly that many alternatives
// on demand, longest-first so the greedy match wins.
//
// jsonBlock (the `(...)` argument form) additionally forbids a leading wrapped
// call: prose desugars to wrapped calls like `(@text[...])`, so a bare call
// followed by prose (`@foo bar` -> `@foo(@text[ bar])`) would otherwise swallow
// that wrapper as a JSON argument and feed the prose to JSON5.parse. Every such
// wrapper names a function, so the lookahead rejects `(@name` specifically
// rather than any `(@` — which leaves `@f(@[...])` and `@f(@{...})` free to open
// a json block, since those forms never appear as a desugared wrapper.
// Mid-string interpolation (`{"who": "@who"}`) was never affected either way,
// since it starts with `{`.
//
// An inline block's body guards each iteration with `~"]<hashes>"` rather than
// leaning on the text rule's blanket `~"]"`: that way a bare ] (or [) inside the
// body falls through to inline<>'s parsedBlockEscapable and comes out literal,
// so `#[a]b]#` holds `a]b` and still closes on `]#`. The guard is what stops the
// escape from eating the closing delimiter.
function blockRules(maxHashes)
{
	const parsed = [];
	const inline = [];
	const raw = [];
	const json = [];

	for (let n = maxHashes; n >= 1; n--)
	{
		const h = "#".repeat(n);
		parsed.push(`"${h}[[" (~"]]${h}" any)* "]]${h}"`);
		inline.push(`"${h}[" (~"]${h}" inline<~"]${h}" any>)+ "]${h}"`);
		raw.push(`"${h}{" (functionCall | (~"}${h}" any))+ "}${h}"`);
		json.push(`"${h}(" ~wrappedCallOpener (functionCall | (~")${h}" any))+ ")${h}"`);
	}

	parsed.push(`"[[" (~"]]" any)* "]]"`);
	inline.push(`"[" (~"]" inline<~"]" any>)* "]"`);
	raw.push(`"{" (functionCall | (~"}" any))* "}"`);
	json.push(`"(" ~wrappedCallOpener (functionCall | (~")" any))* ")"`);

	const join = alts => alts.join("\n\t| ");

	return `parsedBlock
	= ${join(parsed)}

  parsedInlineBlock
	= ${join(inline)}

  rawBlock
	= ${join(raw)}

  jsonBlock
	= ${join(json)}`;
}

function buildGrammarSource(maxHashes)
{
	return String.raw`
spruce {
  // Trailing spaceOrTab* mops up any horizontal whitespace left after the last
  // chunk (a blankLine needs a newline, a paragraph needs an inline char, so a
  // whitespace-only tail with no newline matches no chunk). This happens when a
  // parsedBlock body is re-matched as a document and the closing "]]" is indented:
  // the body ends with that indentation, which would otherwise fail the match.
  document = chunk* spaceOrTab*

  // Raw-mode start rule (see compile's raw flag): the whole document is raw,
  // so only declaration blocks and function calls are interpreted and every other
  // character is literal, exactly as inside a @{} raw block. declarationBlock is
  // tried first (its @@@ opener would otherwise be eaten as an escaped @), then
  // functionCall, so @-calls win over the catch-all any.
  rawDocument = (declarationBlock | functionCall | any)*

  chunk
    = heading
    | codeBlock
    | displayMath
    | declarationBlock
    | unorderedList
    | orderedList
	| htmlTag
    | (spaceOrTab* newline) --blankLine          // Needs to be above paragraph or else newlines will always lead to paragraphs
    | functionCallChunk
    | paragraph
  
  
  
  heading = spaceOrTab* headingHashes spaceOrTab+ inline<~(newline | end) any>+
  headingHashes = "#" "#"? "#"? "#"? "#"? "#"?
  
  
  
  codeBlock
    = spaceOrTab* "${bt}${bt}${bt}" spaceOrTab* alnum* spaceOrTab* newline
      raw<~(newline spaceOrTab* "${bt}${bt}${bt}" (newline | end)) any>*
      newline spaceOrTab* "${bt}${bt}${bt}" &(newline | end)
  
  
  
  displayMath
    = spaceOrTab* "$$" spaceOrTab* newline
      raw<~(newline spaceOrTab* "$$" (newline | end)) any>*
      newline spaceOrTab* "$$" &(newline | end)
  
  
  
  declarationBlock
    = spaceOrTab* "@@@" spaceOrTab* alnum* spaceOrTab* newline
    declarationBlockBody
    declarationBlockTerminator
  
  declarationBlockBody = (~(newline spaceOrTab* "@@@") any)*

  declarationBlockTerminator
    = newline spaceOrTab* "@@@" spaceOrTab* &(newline | end) --hard
    | newline &(spaceOrTab* "@@@" spaceOrTab* alnum)         --soft
  
  
  
  unorderedList = spaceOrTab* unorderedItem (newline space* unorderedItem)* &(newline | end)
  unorderedItem = "-" spaceOrTab+ inline<~(newline | end) any>+

  orderedList = spaceOrTab* orderedItem (newline space* orderedItem)* &(newline | end)
  orderedItem = orderedItemStarter spaceOrTab+ inline<~(newline | end) any>+
  orderedItemStarter
    = (digit+ ".") --numeric
    | "+"          --plus



  htmlTag = spaceOrTab* "<" (functionCall | (~newline any))*
  
  
  
  paragraph = spaceOrTab* inline<~(doubleNewline | end) ~(newline spaceOrTab* "<") any>+

  boldItalic
    = "***" inline<~"***" any>+ "***"
    | "___" inline<~"___" any>+ "___"

  bold
    = "**" ~"*" inline<~"**" any>+ "**" ~"*"
    | "__" ~"_" inline<~"__" any>+ "__" ~"_"

  italic
    = "*" ~"*" inline<~"*" any>+ "*" ~"*"
    | "_" ~"_" inline<~"_" any>+ "_" ~"_"
  
  // This uses inlineWithoutEscapable, because otherwise the display text
  // can eat ] characters
  link
    = "[" inlineWithoutEscapable<~"]" any>+ "]"
      "(" raw<~")" ~doubleNewline any>+ ")"

  // Code and math are non-folding
  code = "${bt}" ~"${bt}" raw<~"${bt}" ~doubleNewline any>+ "${bt}" ~"${bt}"

  math = "$" ~"$" raw<~"$" ~doubleNewline any>+ "$" ~"$"
  inlineDisplayMath = "$$" raw<~"$$" ~doubleNewline any>+ "$$"

  // A run of text desugars to (@text[...]) and is later re-parsed, so literal
  // [ ] in prose would collide with that argument's own delimiters (or, for a
  // leading [, form a spurious [[ block opener). The text rule excludes [ ] so
  // they fall through to parsedBlockEscapable here, which desugars them to the
  // raw escapes @{[}/@{]} — a desugaring action rather than a string rewrite.
  // (Raw mode, not @[/@], because @[ now opens an inline identity block.)
  // inlineWithoutEscapable comes first so link (which also opens with [) still
  // wins over the escape.
  inline<allowed> = inlineWithoutEscapable<allowed> | parsedBlockEscapable

  inlineWithoutEscapable<allowed>
    = boldItalic
    | bold
    | italic
    | code
    | math
    | inlineDisplayMath
    | link
    | functionCall
    | (~boldItalic ~bold ~italic ~code ~math ~inlineDisplayMath ~link ~functionCall ~"[" ~"]" allowed)+ --text

  // Start rule for re-matching a parsedInlineBlock body in isolation (see the
  // parsedInlineBlock desugar handler): the whitespace-trimmed body string is
  // re-parsed as inline content so its desugaring matches what the block would
  // have produced, minus the trimmed leading/trailing whitespace. inline<>, not
  // inlineWithoutEscapable<>, because the body may hold a bare [ or ] that the
  // block's own guard let through (see blockRules).
  inlineContent = inline<~end any>*


  // The raw content of code blocks, display math, etc.
  raw<allowed> = rawBlockEscapable | functionCall | allowed

  newline = "\r\n" | "\n" | "\r"
  doubleNewline = newline spaceOrTab* newline
  
  spaceOrTab = " " | "\t"
  
  

  functionCallChunk = spaceOrTab* functionCall spaceOrTab* (newline | end)
  
  // @[[...]] and @[...] are the identity functions on a parsed block and an
  // inline block respectively: they emit their content unchanged, just like
  // @{...} does for raw content. --parsed comes before --inline so @[[ opens a
  // parsed block rather than an inline block holding a stray [, and both precede
  // --escaped so a well-formed @[/@[[ always opens a block. @[ is no longer a
  // literal-bracket escape; emit a literal [ with the raw escape @{[}. (--escaped
  // still matches a stray, unclosed @[ as a fallback, but its desugar rewrites
  // that to @{[} — see functionCall_escaped — so it can't re-open a block.)
  functionCall
    = "(" spaceOrTab* "@" space* jsIdentifier spacePaddedBlock* space* ")" --wrapped
    | "@" spaceOrTab* jsIdentifier spaceOrTabPaddedBlock*                  --bare
    | "@" spaceOrTab* parsedBlock                                          --parsed
    | "@" spaceOrTab* parsedInlineBlock                                    --inline
    | "@" spaceOrTab* rawBlock                                             --raw
    | "@" (~space any)                                                     --escaped
    | "@" space                                                            --invalid
    
  // The @name head of a wrapped call, exactly as desugaring emits it — flush
  // against the "(" — which is what a jsonBlock's lookahead rejects so a prose
  // wrapper can't be read as a JSON argument (see blockRules). Only the *named*
  // form is excluded: @[...] and @{...} never appear in that position, so they
  // stay usable as json content.
  wrappedCallOpener = "@" spaceOrTab* jsIdentifier

  jsIdentifier = jsIdentifierStart jsIdentifierPart*
  jsIdentifierStart = letter | "_" | "$"
  jsIdentifierPart = jsIdentifierStart | digit
  
  spacePaddedBlock = space* parsedOrRawBlock
  spaceOrTabPaddedBlock = spaceOrTab* parsedOrRawBlock
  parsedOrRawBlock = parsedBlock | parsedInlineBlock | rawBlock | jsonBlock

  ${blockRules(maxHashes)}

  parsedBlockEscapable = "[" | "]"
  rawBlockEscapable = "}"
}`;
}

// Find the deepest run of hashes that forms part of a block delimiter, i.e. one
// immediately followed by an opening bracket/brace/paren (`###[`, `##{`, `#(`, ...)
// or immediately preceded by a closing one (`]###`, `}##`, `)#`, ...). The result
// bounds how many delimiter alternatives the on-demand grammar needs.
function maxHashDepth(text)
{
	let max = 0;
	const re = /#+(?=[[{(])|(?<=[\]})])#+/g;
	let match;
	while ((match = re.exec(text)))
	{
		if (match[0].length > max) max = match[0].length;
	}
	return max;
}

// Compiled grammars (and their attached semantics) are cached by hash depth so
// repeated compiles of similar documents reuse the same instance.
const grammarCache = new Map();

// The grammar and semantics currently in use. They're swapped per input by
// useGrammar so the semantics handlers below (which re-match nested blocks
// against `spruce`) always see the variant that can parse the active document.
let spruce;
let semantics;

function useGrammar(maxHashes)
{
	let entry = grammarCache.get(maxHashes);

	if (!entry)
	{
		const grammar = ohm.grammar(buildGrammarSource(maxHashes));
		entry = { grammar, semantics: attachSemantics(grammar.createSemantics()) };
		grammarCache.set(maxHashes, entry);
	}

	spruce = entry.grammar;
	semantics = entry.semantics;
	return entry;
}

// Build (or reuse) the grammar that can parse `text`, make it active, and return
// the compiled grammar. Used by tooling (e.g. the editor tokenizer) that needs
// the ohm grammar directly rather than going through compile().
export function grammarFor(text)
{
	return useGrammar(maxHashDepth(text)).grammar;
}

// Each handler that emits a function call into the desugared output captures
// its location in the *original* source. The id is a sequential counter shared
// with getCode — both walk their parse trees in source order, so the nth
// emitted function call here matches the nth function call getCode encounters.
let nextFunctionCallId = 0;
let functionCallLocations = {};

let declarationBlockOriginalLines = [];

// parsedBlock ([[ ]]) re-matches its body as a fresh document, so getLineAndColumn
// on nodes inside that re-match is relative to the body substring (its line 1),
// not the original source. This is the line-based analog of getCodeOffset: it
// holds the original-source line number that the current re-match's line 1 maps
// to, and accumulates through nesting. Reset by desugar(); pushed/popped around
// each re-match in parsedBlock. captureFunctionCall folds it into stored lineNums
// so runtime errors point at the real source line.
let desugarLineBase = 1;

// When false (the default), the body of a parsed block is cleaned up before it's
// handed to the function: inline [ ] bodies are trimmed of leading/trailing
// whitespace, and [[ ]] bodies are dedented (see dedentBlock). The CLI's
// -w/--preserve-whitespace flag sets this true to keep the raw body (and also
// skips functionCallChunk output re-indentation). Set per compile by _compileImpl.
let preserveWhitespace = false;

function globalizeLineNum(localLineNum)
{
	return desugarLineBase + localLineNum - 1;
}

// Count the newlines in the leading-whitespace run of `str` (whatever
// String.prototype.trimStart would strip). Used to advance desugarLineBase past
// the whitespace a parsed block trims, so nested captures still globalize onto
// the original source line where the trimmed content actually begins.
function leadingTrimNewlines(str)
{
	const leading = str.slice(0, str.length - str.trimStart().length);
	return (leading.match(/\r\n|\r|\n/g) || []).length;
}

// Visual width of a line's leading whitespace run, counting a tab as 4 columns.
// Lines that are entirely whitespace report no indentation so they don't drag
// the block's common-indent measurement down to zero.
function indentWidth(line)
{
	let width = 0;
	for (const ch of line)
	{
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4;
		else break;
	}
	return width;
}

// The default whitespace treatment for a [[ ]] parsed-block body: find the
// least-indented contentful line (tab = 4 columns) and remove that much
// indentation from every line, so a block indented for source-readability doesn't
// leak that indentation into the content it carries. Leading/trailing blank lines
// are left intact. Step 3 — re-indenting the call's *output* by the call line's
// own indentation — lives in insertCodeOutput's functionCallChunk handler, since
// it acts on the rendered result rather than the source body.
function dedentBlock(str)
{
	const lines = str.split(/\r\n|\r|\n/);

	const contentful = lines.filter(line => line.trim() !== "");
	if (contentful.length === 0) return str;

	const minIndent = Math.min(...contentful.map(indentWidth));

	return lines.map(line =>
	{
		// Walk off `minIndent` columns of leading whitespace. If a tab straddles the
		// cut point, re-pad the columns past it with spaces so we never remove more
		// indentation than measured.
		let col = 0;
		let i = 0;
		while (i < line.length && col < minIndent)
		{
			if (line[i] === " ") col += 1;
			else if (line[i] === "\t") col += 4;
			else break;
			i++;
		}
		const overshoot = col - minIndent;
		return " ".repeat(Math.max(0, overshoot)) + line.slice(i);
	}).join("\n");
}

function captureFunctionCall(node)
{
	const location = node.source.getLineAndColumn();
	location.lineNum = globalizeLineNum(location.lineNum);
	functionCallLocations[nextFunctionCallId++] = location;
}

// Convert all syntactic sugar to function calls, escaping characters as necessary.
// The only characters that are unescaped are those in raw environments that would
// no longer considered valid escape sequences when desugaring.
// Attach all operations to a freshly created semantics for a given grammar.
// Called once per cached grammar variant by useGrammar.
function attachSemantics(sem)
{
	sem.addOperation("desugar", desugarOperation);
	sem.addOperation("getCode", getCodeOperation);
	sem.addOperation("insertCodeOutput(__spruceOutput)", insertCodeOutputOperation);
	return sem;
}

const desugarOperation = {
	heading(_1, hashes, _2, body)
	{
		captureFunctionCall(this);
		return `(@heading[${body.desugar()}]{${hashes.sourceString.length}})`;
	},

	codeBlock(_1, _2, _3, language, _4, _5, body, _6, _7, _8, _9)
	{
		captureFunctionCall(this);
		return `(@codeBlock{${body.desugar()}}{${language.desugar()}})`;
	},

	displayMath(_1, _2, _3, _4, body, _5, _6, _7, _8)
	{
		captureFunctionCall(this);
		return `(@displayMath{${body.desugar()}})`;
	},

	declarationBlock(_1, _2, _3, scope, _4, _5, body, _6)
	{
		declarationBlockOriginalLines.push(globalizeLineNum(body.source.getLineAndColumn().lineNum));
		return this.sourceString;
	},

	unorderedList(_1, firstItem, _2, _3, restItems, _4)
	{
		captureFunctionCall(this);
		const restItemsWrapped = restItems.children.map(item => `[${item.desugar()}]`).join("");

		return `(@unorderedList[${firstItem.desugar()}]${restItemsWrapped})`;
	},

	unorderedItem(_1, _2, body)
	{
		return body.desugar();
	},

	orderedList(_1, firstItem, _2, _3, restItems, _4)
	{
		captureFunctionCall(this);
		const restItemsWrapped = restItems.children.map(item => `[${item.desugar()}]`).join("");

		return `(@orderedList[${firstItem.desugar()}]${restItemsWrapped})`;
	},

	orderedItem(_1, _2, body)
	{
		return body.desugar();
	},

	paragraph(_1, body)
	{
		captureFunctionCall(this);
		return `(@paragraph[${body.desugar()}])`;
	},



	boldItalic(_1, body, _2)
	{
		captureFunctionCall(this);
		return `(@boldItalic[${body.desugar()}])`;
	},

	bold(_1, body, _2)
	{
		captureFunctionCall(this);
		return `(@bold[${body.desugar()}])`;
	},

	italic(_1, body, _2)
	{
		captureFunctionCall(this);
		return `(@italic[${body.desugar()}])`;
	},

	link(_1, displayText, _2, _3, url, _4)
	{
		captureFunctionCall(this);
		return `(@link[${displayText.desugar()}]{${url.desugar()}})`;
	},

	code(_1, body, _2)
	{
		captureFunctionCall(this);
		return `(@code{${body.desugar()}})`;
	},

	math(_1, body, _2)
	{
		captureFunctionCall(this);
		return `(@math{${body.desugar()}})`;
	},

	inlineDisplayMath(_1, body, _2)
	{
		captureFunctionCall(this);
		return `(@inlineDisplayMath{${body.desugar()}})`;
	},

	inlineWithoutEscapable_text(body)
	{
		// Must capture here even though @text is generated rather than written by
		// the user: getCode counts every wrapped/bare call it walks in the desugared
		// tree (including this one), so skipping the capture would shift every
		// subsequent call's location by one and misattribute runtime errors.
		captureFunctionCall(this);
		return `(@text[${body.desugar()}])`;
	},

	

	functionCall_wrapped(_1, _2, _3, _4, name, spacePaddedBlocks, _5, _6)
	{
		captureFunctionCall(this);
		return `(@${name.desugar()}${spacePaddedBlocks.desugar()})`;
	},

	functionCall_bare(_1, _2, name, spaceOrTabPaddedBlocks)
	{
		captureFunctionCall(this);
		return `@${name.desugar()}${spaceOrTabPaddedBlocks.desugar()}`;
	},

	// @[[...]] / @[...] / @{...}: identity functions on a parsed, inline, or raw
	// block. The block desugars itself (recursing into nested calls/escapes) and we
	// re-emit it behind the @ so the re-parse recognizes the same identity call —
	// no captureFunctionCall, since these emit their content without a runtime call.
	functionCall_parsed(_1, _2, block)
	{
		return `@${block.desugar()}`;
	},

	functionCall_inline(_1, _2, block)
	{
		return `@${block.desugar()}`;
	},

	functionCall_raw(_1, _2, block)
	{
		return `@${block.desugar()}`;
	},

	functionCall_escaped(_1, character)
	{
		// A stray @[ reaches here only when --inline/--parsed failed to open a block
		// (unclosed, or bare [ ] in the content). Desugaring it back to a literal @[
		// would re-open an inline block on re-parse, so rewrite it to the raw escape
		// @{[}, which yields a literal [ and can't be read as a block opener.
		if (character.sourceString === "[")
		{
			return "@{[}";
		}

		return this.sourceString;
	},

	functionCall_invalid(_1, space)
	{
		const { lineNum, colNum } = this.source.getLineAndColumn();
		renderContext(this.source.sourceString, lineNum, line =>
		{
			const startCol = colNum - 1;
			const before = line.slice(0, startCol);
			const offending = line.slice(startCol, startCol + 2); // @ + the space
			const after = line.slice(startCol + 2);
			return `${before}${RED_BOLD}${offending}${RESET}${after}`;
		});
		throw new Error(`Expected an identifier, parentheses, or raw block following @.`);
	},

	jsIdentifier(_1, _2)
	{
		return this.sourceString;
	},

	spacePaddedBlock(_1, block)
	{
		return block.desugar();
	},

	spaceOrTabPaddedBlock(_1, block)
	{
		return block.desugar();
	},

	parsedBlock(start, body, end)
	{
		// By default the body is dedented (common indentation stripped) so the
		// function receives just the middle; -w/--preserve-whitespace keeps it raw.
		// This happens here, on the string re-matched as a document, so getCode
		// (which walks the desugared output) sees the already-dedented content
		// without extra bookkeeping.
		const bodyStr = preserveWhitespace ? body.sourceString : dedentBlock(body.sourceString);
		const inner = spruce.match(bodyStr, "document");

		if (inner.failed())
		{
			throw new Error(inner.message);
		}

		// Shift the line base so nested captures globalize correctly: the re-match's
		// line 1 corresponds to the original-source line where this body begins.
		// Mirrors getCode's getCodeOffset bookkeeping, but line-based. Restore after.
		// Dedent only strips per-line indentation and keeps every line, so no leading
		// lines are dropped and the body's first line still maps to the re-match's.
		const savedBase = desugarLineBase;
		desugarLineBase = globalizeLineNum(body.source.getLineAndColumn().lineNum);
		const innerDesugared = semantics(inner).desugar();
		desugarLineBase = savedBase;

		return `${start.desugar()}${innerDesugared}${end.desugar()}`;
	},

	parsedInlineBlock(start, body, end)
	{
		if (preserveWhitespace)
		{
			return `${start.desugar()}${body.desugar()}${end.desugar()}`;
		}

		// Trim the body so the call receives just the middle. The body subtree can't
		// be desugared in place without re-including its surrounding whitespace (it
		// lives inside the first/last text run), so re-match the trimmed string as
		// inline content and desugar that — the inlineContent rule yields the same
		// desugaring the block body would, minus the trimmed whitespace.
		const inner = spruce.match(body.sourceString.trim(), "inlineContent");

		if (inner.failed())
		{
			throw new Error(inner.message);
		}

		const savedBase = desugarLineBase;
		const skippedLines = leadingTrimNewlines(body.sourceString);
		desugarLineBase = globalizeLineNum(body.source.getLineAndColumn().lineNum + skippedLines);
		const innerDesugared = semantics(inner).desugar();
		desugarLineBase = savedBase;

		return `${start.desugar()}${innerDesugared}${end.desugar()}`;
	},

	rawBlock(start, body, end)
	{
		return `${start.desugar()}${body.desugar()}${end.desugar()}`;
	},

	// Like rawBlock: preserve the (...) delimiters and desugar the body (so nested
	// @-calls and escapes are rewritten) so the re-parse re-recognizes it as a
	// jsonBlock argument. getCode wraps the body in JSON5.parse(...) at the call site.
	jsonBlock(start, body, end)
	{
		return `${start.desugar()}${body.desugar()}${end.desugar()}`;
	},



	parsedBlockEscapable(character)
	{
		// Raw-mode escape (@{[} / @{]}) rather than @[ / @], since @[ now opens an
		// inline identity block. The raw block emits the bracket literally.
		return `@{${character.desugar()}}`;
	},

	rawBlockEscapable(character)
	{
		return `@${character.desugar()}`;
	},



	_terminal()
	{
		return this.sourceString;
	},

	_nonterminal(...children)
	{
		return children.map(c => c.desugar()).join("");
	},

	_iter(...children)
	{
		return children.map(c => c.desugar()).join("");
	},
};



// Produces the code to be run. We do *not* want this to be nested, so they
// get written in order to this accumulator, which is reset by getCode().
// getCode walks the desugared parse tree in the same order desugar walked the
// original, so the nth function call here corresponds to the nth captured
// location — we use that to rekey locations by desugared startIdx.
//
// Function-call arguments are emitted as JS template literals so that nested
// function calls can interpolate via `${<storageName>[<id>]}`. Raw text
// pieces therefore need to be escaped for use inside a template literal.
//
// `storageName` is the identifier under which results are accumulated in the
// generated module. It is randomized per compile (see the getCode wrapper)
// so that user code in declaration blocks can't reach in by name and tamper
// with it; the module re-exports it under the stable alias `__spruceOutput`
// so the host's `module.__spruceOutput` read still resolves.
let codeToExecute = "";
let nextGetCodeId = 0;
// parsedBlock re-matches its body as a fresh document (the grammar stores it as
// raw text), so nested calls come back with startIdx relative to that body —
// 0-based, and thus colliding across sibling parsed-block arguments. We add this
// running offset (the body's global start, accumulated through nesting) to every
// id so each call recovers its true startIdx in the desugared document and stays
// unique. Reset by getCode(); pushed/popped around each re-match in parsedBlock.
let getCodeOffset = 0;
// Set by the jsonBlock handler immediately before it compiles a direct
// @[...] / @[[...]] child that sits outside any JSON5 string literal, and read
// (and cleared) by identityBlockCode. An identity block renders to text, so on
// its own it would drop bare words into the JSON5 source; quoting it there makes
// it the string it already is. The flag is cleared the moment it's consumed, so
// it can never reach an identity nested deeper inside that call's own arguments
// (`(a: @f[@[x]])`) — only a json body's immediate child is ever quoted.
let quoteNextIdentity = false;
let locationsByStartIdx = {};
let nextGetCodeDeclarationId = 0;
let declarationBlockRanges = [];
let storageName = "__spruceOutput";
let currentOutputFormat = "";

function escapeForTemplate(s)
{
	return s
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/\$\{/g, "\\${");
}

// A function-call argument block compiles to a JS expression. parsed/inline/raw
// blocks become a template literal so their text (and any nested `${...}` call
// results) flows through as a string. A jsonBlock instead runs that same text
// through JSON5.parse, so the function receives a real number/boolean/array/object
// rather than a string. `block` is the parsedOrRawBlock node; its first child is
// the matched alternative, whose rule name tells the two paths apart.
function compileArgument(block)
{
	const inner = block.getCode();
	return block.child(0).ctorName === "jsonBlock"
		? `JSON5.parse(\`${inner}\`)`
		: "`" + inner + "`";
}

// True for an @[...] / @[[...]] identity call — the two forms whose output is
// always text. `node` is a `functionCall` node; its lone child names the
// alternative that matched.
function isIdentityCall(node)
{
	const alternative = node.child(0).ctorName;
	return alternative === "functionCall_inline" || alternative === "functionCall_parsed";
}

// Shared by the @[[...]] / @[...] identity calls (functionCall_parsed/_inline).
// `node` is the functionCall node, `block` its parsed/inline block. Stores the
// block's rendered content (a template literal, so nested ${...} call results
// flow through) under the call's startIdx and returns the ${storage[id]}
// placeholder, exactly like a wrapped/bare call but with no function applied —
// the identity. block.getCode() also emits the inner calls' assignments.
//
// Inside a jsonBlock the stored value is additionally JSON.stringify'd (see
// quoteNextIdentity), so `@f({a: @[hi]})` hands JSON5.parse `{a: "hi"}` rather
// than the bare word `hi`.
function identityBlockCode(node, block)
{
	const startIdx = node.source.startIdx + getCodeOffset;
	const id = JSON.stringify(startIdx);
	// Read-and-clear before descending: the block's own body is parsed content,
	// not JSON, so a nested identity in there must not inherit the quoting.
	const quote = quoteNextIdentity;
	quoteNextIdentity = false;
	// Resolve block.getCode() into a local *before* the `codeToExecute +=`: it
	// appends the inner calls' assignments as a side effect, and a compound
	// assignment reads codeToExecute's old value before evaluating the RHS, so
	// inlining the call would discard those inner assignments.
	const inner = block.getCode();
	const value = "`" + inner + "`";
	// JSON.stringify, not bare quotes: the rendered text may hold quotes, newlines
	// or backslashes, and all of those have to survive JSON5.parse.
	codeToExecute += `${storageName}[${id}] = ${quote ? `JSON.stringify(${value})` : value};\n`;
	return "${" + storageName + "[" + id + "]}";
}

const getCodeOperation = {
	declarationBlock(_1, _2, _3, scope, _4, _5, body, _6)
	{
		const originalStart = declarationBlockOriginalLines[nextGetCodeDeclarationId++];

		if (!scope.sourceString || scope.sourceString === currentOutputFormat)
		{
			const linesBefore = codeToExecute.split("\n").length;
			codeToExecute += "\n" + body.sourceString + "\n\n";

			// +1: leading "\n" lands the body on the next line in codeToExecute.
			// +1: runCode prepends an `export const __spruceOutput = {};` line.
			const generatedStart = linesBefore + 2;
			const bodyLineCount = body.sourceString.split("\n").length;

			declarationBlockRanges.push({
				generatedStart,
				generatedEnd: generatedStart + bodyLineCount - 1,
				originalStart,
			});
		}

		return "";
	},

	functionCall_wrapped(_1, _2, _3, _4, name, spacePaddedBlocks, _5, _6)
	{
		const startIdx = this.source.startIdx + getCodeOffset;
		const id = JSON.stringify(startIdx);

		locationsByStartIdx[startIdx] = functionCallLocations[nextGetCodeId++];

		const functionArguments = spacePaddedBlocks.children
			.map(block => block.getCode())
			.join(",");

		const nameCode = name.getCode();

		// With args, do a plain call so a non-function (i.e. a constant) lets
		// JS throw a TypeError that logSourceError can render. Without args,
		// keep the typeof guard so a bare `@x` resolves to the constant value.
		const rhs = spacePaddedBlocks.children.length > 0
			? `${nameCode}(${functionArguments})`
			: `typeof ${nameCode} === "function" ? ${nameCode}() : ${nameCode}`;

		codeToExecute += `${storageName}[${id}] = ${rhs};\n`;

		return "${" + storageName + "[" + id + "]}";
	},

	functionCall_bare(_1, _2, name, spaceOrTabPaddedBlocks)
	{
		const startIdx = this.source.startIdx + getCodeOffset;
		const id = JSON.stringify(startIdx);

		locationsByStartIdx[startIdx] = functionCallLocations[nextGetCodeId++];

		const functionArguments = spaceOrTabPaddedBlocks.children
			.map(block => block.getCode())
			.join(",");

		const nameCode = name.getCode();

		const rhs = spaceOrTabPaddedBlocks.children.length > 0
			? `${nameCode}(${functionArguments})`
			: `typeof ${nameCode} === "function" ? ${nameCode}() : ${nameCode}`;

		codeToExecute += `${storageName}[${id}] = ${rhs};\n`;

		return "${" + storageName + "[" + id + "]}";
	},

	// @[[...]] / @[...]: identity on a parsed / inline block. Unlike @{...} (whose
	// body is parsed in place, so insertCodeOutput can descend and the rawBlock
	// handler drops the braces), a parsedBlock body is stored as raw text that
	// getCode must re-match — its inner calls live in that throwaway re-match, out
	// of insertCodeOutput's reach. So compile both like a real call: store the
	// rendered block under this call's id (a backtick-wrapped template literal, no
	// delimiters) and emit ${storage[id]}; insertCodeOutput then looks it up. No
	// location is captured — the identity itself can't throw; inner calls carry
	// their own locations.
	functionCall_parsed(_1, _2, block)
	{
		return identityBlockCode(this, block);
	},

	functionCall_inline(_1, _2, block)
	{
		return identityBlockCode(this, block);
	},

	functionCall_raw(_1, _2, block)
	{
		return block.getCode();
	},

	functionCall_escaped(_1, character)
	{
		return character.getCode();
	},

	jsIdentifier(_1, _2)
	{
		return this.sourceString;
	},

	// Both padded-block forms are only ever a function-call argument, so they
	// own the wrapping: a string template literal, or JSON5.parse for a jsonBlock.
	spacePaddedBlock(_1, block)
	{
		return compileArgument(block);
	},

	spaceOrTabPaddedBlock(_1, block)
	{
		return compileArgument(block);
	},

	parsedBlock(open, body, close)
	{
		const inner = spruce.match(body.sourceString, "document");

		if (inner.failed())
		{
			throw new Error(inner.message);
		}

		// The re-match restarts startIdx at 0, so shift ids by the body's global
		// start (relative to the current source, itself already shifted for nested
		// blocks) and restore afterward. This recovers each nested call's true
		// startIdx in the desugared document, keeping ids unique across siblings.
		const saved = getCodeOffset;
		getCodeOffset = saved + body.source.startIdx;
		const code = semantics(inner).getCode();
		getCodeOffset = saved;

		return code;
	},

	parsedInlineBlock(_1, body, _2)
	{
		return body.getCode();
	},

	rawBlock(_1, body, _2)
	{
		return body.getCode();
	},

	// Same template-literal body as a raw block; compileArgument wraps it in
	// JSON5.parse(`...`) so the text is parsed into a real value at runtime.
	//
	// The body is emitted child by child rather than by the default join so we can
	// track whether each one sits inside a JSON5 string literal. An @[...] /
	// @[[...]] identity block renders to text, so outside a string it has to be
	// quoted to be valid JSON (`{a: @[hi]}` -> `{a: "hi"}`); inside one the
	// surrounding quotes already do that (`{a: "x@[hi]y"}`), and adding more would
	// break the parse. Walking children instead of scanning the raw text keeps a
	// quote inside a nested call's own argument from flipping the state, matching
	// how the extension's JSON highlighter treats each call as one opaque span.
	jsonBlock(_1, body, _2)
	{
		let code = "";
		let quote = null;
		let escaped = false;

		for (const child of body.children)
		{
			if (child.ctorName === "functionCall")
			{
				quoteNextIdentity = quote === null && isIdentityCall(child);
				code += child.getCode();
				quoteNextIdentity = false;
				continue;
			}

			code += child.getCode();

			const character = child.sourceString;

			if (escaped) escaped = false;
			else if (quote === null) quote = character === '"' || character === "'" ? character : null;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
		}

		return code;
	},



	_terminal()
	{
		return escapeForTemplate(this.sourceString);
	},

	_nonterminal(...children)
	{
		return children.map(c => c.getCode()).join("");
	},

	_iter(...children)
	{
		return children.map(c => c.getCode()).join("");
	},
};



const insertCodeOutputOperation = {
	declarationBlock(_1, _2, _3, scope, _4, _5, body, _6)
	{
		return "";
	},

	// A function call alone on its line. By default, add the call line's own
	// leading indentation to *every* line of the rendered output, not just the
	// first (which already carries it as the literal prefix) — so a multi-line
	// result stays block-aligned under the call. -w/--preserve-whitespace leaves
	// the output verbatim, matching the disabled body dedent.
	functionCallChunk(leadingWhitespace, call, trailingWhitespace, terminator)
	{
		const __spruceOutput = this.args.__spruceOutput;
		const indent = leadingWhitespace.sourceString;
		const callOutput = call.insertCodeOutput(__spruceOutput);

		const reindented = preserveWhitespace
			? indent + callOutput
			: indent + callOutput.replace(/\r\n|\r|\n/g, match => match + indent);

		return reindented
			+ trailingWhitespace.insertCodeOutput(__spruceOutput)
			+ terminator.insertCodeOutput(__spruceOutput);
	},

	functionCall_wrapped(_1, _2, _3, _4, name, spacePaddedBlocks, _5, _6)
	{
		const id = JSON.stringify(this.source.startIdx);
		return this.args.__spruceOutput[id];
	},

	functionCall_bare(_1, _2, name, spaceOrTabPaddedBlocks)
	{
		const id = JSON.stringify(this.source.startIdx);
		return this.args.__spruceOutput[id];
	},

	// Identity calls: look up the rendered block stored by getCode, just like a
	// wrapped/bare call. (Descending instead would re-emit the [[ ]] / [ ]
	// delimiters and, for a parsedBlock, its un-rendered raw-text body.)
	functionCall_parsed(_1, _2, block)
	{
		const id = JSON.stringify(this.source.startIdx);
		return this.args.__spruceOutput[id];
	},

	functionCall_inline(_1, _2, block)
	{
		const id = JSON.stringify(this.source.startIdx);
		return this.args.__spruceOutput[id];
	},

	functionCall_raw(_1, _2, block)
	{
		return block.insertCodeOutput(this.args.__spruceOutput);
	},

	functionCall_escaped(_1, character)
	{
		// Final output pass: emit the literal character. Unlike getCode (which
		// escapes for embedding in a generated template literal), this string is
		// the output itself, so escaping here would leak a stray backslash for
		// characters like ` that escapeForTemplate touches.
		return character.sourceString;
	},

	rawBlock(_1, body, _2)
	{
		return body.insertCodeOutput(this.args.__spruceOutput);
	},



	_terminal()
	{
		return this.sourceString;
	},

	_nonterminal(...children)
	{
		return children.map(c => c.insertCodeOutput(this.args.__spruceOutput)).join("");
	},

	_iter(...children)
	{
		return children.map(c => c.insertCodeOutput(this.args.__spruceOutput)).join("");
	},
};



function desugar(matchResult)
{
	nextFunctionCallId = 0;
	functionCallLocations = {};
	declarationBlockOriginalLines = [];
	desugarLineBase = 1;
	return semantics(matchResult).desugar();
}

function getCode(matchResult, outputFormat)
{
	codeToExecute = "";
	nextGetCodeId = 0;
	getCodeOffset = 0;
	locationsByStartIdx = {};
	nextGetCodeDeclarationId = 0;
	declarationBlockRanges = [];
	storageName = `__spruce_${randomUUID().replaceAll("-", "_")}`;
	currentOutputFormat = outputFormat;

	semantics(matchResult).getCode();

	return {
		codeToExecute,
		functionCallLocations: locationsByStartIdx,
		declarationBlockRanges,
		storageName,
	};
}

function insertCodeOutput(matchResult, __spruceOutput)
{
	return semantics(matchResult).insertCodeOutput(__spruceOutput);
}

const RED_BOLD = "\x1b[1;31m";
const RESET = "\x1b[0m";

function renderContext(source, errorLine, highlightContent)
{
	const sourceLines = source.split("\n");
	const numContextLines = 3;
	const start = Math.max(0, errorLine - numContextLines - 1);
	const end = Math.min(sourceLines.length, errorLine + numContextLines);

	const parts = [];

	for (let i = start; i < end; i++)
	{
		const lineNum = String(i + 1).padStart(4);
		const lineContent = sourceLines[i];

		if (i + 1 === errorLine)
		{
			parts.push(`${RED_BOLD}${lineNum}${RESET} | ${highlightContent(lineContent)}`);
		}
		else
		{
			parts.push(`${lineNum} | ${lineContent}`);
		}
	}

	console.log(parts.join("\n"));
}

// Print the underlying JS error (e.g. "ReferenceError: g is not defined") after
// the rendered source context. renderContext shows *where* the error is; this
// shows *what* it is. `${ex}` yields "Name: message" without the noisy stack.
function logErrorMessage(ex)
{
	console.log(`\n${RED_BOLD}${ex}${RESET}`);
}

function logSourceError(ex, body, source, functionCallLocations, declarationBlockRanges, storageName)
{
	const stack = ex.stack || `${ex}`;
	// The stack frame for the generated fragment reads
	// `.__fragments_<uuid>.mjs:LINE:COL`; pull out the line number.
	const fragmentMatch = stack.match(/\.__fragments_[^:?]+\.mjs:(\d+):\d+/);

	if (!fragmentMatch) return false;

	const errorLineInBody = parseInt(fragmentMatch[1]);
	const bodyLine = body.split("\n")[errorLineInBody - 1] || "";
	// Matches both forms emitted by getCode:
	//   <storageName>[N] = name(...);
	//   <storageName>[N] = typeof name === "function" ? name() : name;
	// storageName is `__spruce_<uuid-hex>` (only [a-zA-Z0-9_]), regex-safe.
	const callMatch = bodyLine.match(new RegExp(
		`${storageName}\\[(\\d+)\\]\\s*=\\s*(?:typeof\\s+)?([A-Za-z_$][\\w$]*)`
	));

	if (callMatch)
	{
		const [, id, funcName] = callMatch;
		const location = functionCallLocations[id];

		if (!location) return false;

		// A malformed jsonBlock argument throws from the JSON5.parse wrapping that
		// argument, not from the function itself, so highlighting the function name
		// would blame the wrong token. Detect that case (a SyntaxError on a line that
		// carries a JSON5.parse call) and highlight the whole call from its start
		// column instead — the bad argument lives inside it.
		const isJsonError = ex instanceof SyntaxError && bodyLine.includes("JSON5.parse");

		renderContext(source, location.lineNum, lineContent =>
		{
			if (isJsonError)
			{
				const startCol = (location.colNum ?? 1) - 1;
				const before = lineContent.slice(0, startCol);
				const offending = lineContent.slice(startCol);
				return `${before}${RED_BOLD}${offending}${RESET}`;
			}

			const funcIdx = lineContent.indexOf(funcName);

			if (funcIdx >= 0)
			{
				const before = lineContent.slice(0, funcIdx);
				const after = lineContent.slice(funcIdx + funcName.length);
				return `${before}${RED_BOLD}${funcName}${RESET}${after}`;
			}

			return `${RED_BOLD}${lineContent}${RESET}`;
		});

		logErrorMessage(ex);
		return true;
	}

	for (const range of declarationBlockRanges)
	{
		if (errorLineInBody >= range.generatedStart && errorLineInBody <= range.generatedEnd)
		{
			const originalLine = range.originalStart + (errorLineInBody - range.generatedStart);
			renderContext(source, originalLine, lineContent => `${RED_BOLD}${lineContent}${RESET}`);
			logErrorMessage(ex);
			return true;
		}
	}

	return false;
}

async function runCode(code, source, functionCallLocations, declarationBlockRanges, storageName, baseDir = process.cwd(), filePath = null)
{
	// Post-compile hooks (e.g. `document`) run on the host after this module,
	// so a declaration-block binding can't shadow them the way inline @-calls
	// do. Capture any such binding into the storage object as an epilogue —
	// `typeof` stays safe when the name was never declared — so the host can
	// prefer it over the stdlib default. Appended after the user code, so it
	// doesn't shift any declarationBlockRanges line offsets.
	const captureOverrides = POST_COMPILE_HOOKS
		.map(name => `if(typeof ${name}!=="undefined")(${storageName}[${JSON.stringify(HOOK_OVERRIDES_KEY)}]??={})[${JSON.stringify(name)}]=${name};`)
		.join("\n");

	// One-line prelude so declarationBlockRanges' line offset (linesBefore + 2)
	// stays correct. The storage var is randomized; the export-as alias keeps
	// `module.__spruceOutput` resolving for the host-side read below.
	const body = `const ${storageName} = {}; export { ${storageName} as __spruceOutput };
${code}
${captureOverrides}`;
	if (process.env.SPRUCE_DEBUG_BODY) console.error("---BODY---\n" + body + "\n---END---");

	// The fragment is written alongside the source document (baseDir), so the
	// relative specifiers in its declaration-block imports resolve against the
	// document's own directory — the intuitive, location-stable choice.
	const path = join(baseDir, `.__fragments_${randomUUID()}.mjs`);

	// Track the path *before* writing so that even a partial write (e.g. the file
	// is created and then writeFile fails mid-stream on ENOSPC/EIO) is still owned
	// by the cleanup machinery rather than orphaned on disk.
	pendingCleanup.add(path);

	// The fragment can't be written if baseDir doesn't exist or isn't writable —
	// most commonly because compile() was handed a filePath in a directory that
	// isn't there. Surface that as a clear message instead of letting the raw
	// ENOENT for the randomly-named temp file bubble up from deep in writeFile.
	try
	{
		await writeFile(path, body);
	}

	catch(ex)
	{
		await removeFragment(path);
		throw new Error(`Couldn't write the compiled output to ${baseDir}${filePath ? ` (the directory of filePath "${filePath}")` : ""}: ${ex.message}`);
	}

	const moduleUrl = pathToFileURL(path);

	try
	{
		const module = await import(moduleUrl.href);
		return module.__spruceOutput;
	}

	catch(ex)
	{
		const rendered = logSourceError(ex, body, source, functionCallLocations, declarationBlockRanges, storageName);
		const error = new Error(`${ex}`);
		// Tell the CLI whether renderContext already printed the offending line, so
		// it can suppress the noisy JS stack and just exit when we've shown context.
		error.spruceContextRendered = rendered;
		throw error;
	}

	// Runs on both the success and failure paths; a throw above still cleans up.
	finally
	{
		await removeFragment(path);
	}
}

// Delete a fragment and stop tracking it — but only once it is provably gone.
// If unlink fails for any reason other than "already absent", the file is left
// in pendingCleanup so the synchronous exit handler gets a second chance at it.
async function removeFragment(path)
{
	try
	{
		await unlink(path);
		pendingCleanup.delete(path);
	}

	catch(ex)
	{
		// ENOENT means the file isn't there (never written, or already removed),
		// so there's nothing left to leak — drop it from tracking. Any other error
		// (EBUSY, EPERM, ...) is transient/recoverable, so keep tracking it.
		if (ex.code === "ENOENT") pendingCleanup.delete(path);
	}
}

// Last-resort synchronous sweep. Runs on normal exit and on every signal we
// translate into an exit below, so anything still tracked (a fragment whose
// async unlink failed, or one in flight when a signal arrived) gets removed.
process.on("exit", () =>
{
	for (const path of pendingCleanup)
	{
		try { unlinkSync(path); } catch {}
	}
});

// Signals bypass the normal 'exit' flow, so re-raise them as an explicit
// process.exit() to guarantee the sweep above runs before we terminate.
// Conventional 128+signo exit codes: SIGINT=130, SIGTERM=143, SIGHUP=129.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("SIGHUP", () => process.exit(129));



// Serialize compile() calls. desugar/getCode share module-level state across
// await boundaries; the globalThis snapshot below also needs single-owner
// access. Chaining keeps the public API a plain async function.
let compileQueue = Promise.resolve();

// Compile `content` to `outputFormat`, returning the rendered string. `options`
// is an object: { raw, preserveWhitespace, filePath, standardLibrary }. `filePath`
// (default null) is the document's absolute path, exposed to the document as the
// `filePath` global and used to resolve declaration-block imports relative to its
// directory. `standardLibrary` (default null) is a path to a JS file whose named
// exports are made available to the document, overriding the built-in stdlib but
// still shadowable by declaration-block declarations and imports.
export function compile(content, outputFormat, options = {})
{
	const next = compileQueue.then(() => _compileImpl(content, outputFormat, options));
	compileQueue = next.catch(() => {});
	return next;
}

async function _compileImpl(input, outputFormat, { raw = false, preserveWhitespace: preserveWs = false, filePath = null, standardLibrary = null } = {})
{
	// Trimming of parsed-block bodies is the default; preserveWhitespace
	// keeps them raw. Set before any desugaring so the block handlers see it.
	preserveWhitespace = preserveWs;

	// Snapshot the keys we're about to splat so we can restore on the way out.
	// Users still override behavior by declaring/importing the name in their
	// document — that shadows globalThis during the generated module's
	// execution exactly as before — but after compile() returns, the host's
	// globalThis is unchanged.
	const snapshot = [];
	const setGlobal = (key, value) =>
	{
		snapshot.push(Object.hasOwn(globalThis, key)
			? { key, had: true, value: globalThis[key] }
			: { key, had: false });
		globalThis[key] = value;
	};

	if (Object.hasOwn(stdlib, outputFormat))
	{
		for (const [key, value] of Object.entries(stdlib[outputFormat]))
		{
			if (POST_COMPILE_HOOKS.includes(key)) continue;
			setGlobal(key, value);
		}
	}

	// Expose the input's absolute path as a global constant so the document body
	// (and any files it imports, which share this globalThis) can read it by bare
	// name. Splatted through setGlobal so it's restored when compile() returns.
	setGlobal("filePath", filePath);

	// jsonBlock arguments compile to JSON5.parse(...) calls in the generated
	// module, which can only see globals — splat JSON5 in alongside the stdlib
	// and restore it when compile() returns.
	setGlobal("JSON5", JSON5);

	// Post-compile hooks (e.g. `document`) exported by the user standard library.
	// Collected rather than splatted as globals because these run on the host after
	// the module — like the stdlib hooks — so they can't be reached as inline calls.
	// They beat the stdlib default but lose to a declaration-block override.
	const standardLibraryHooks = {};

	try
	{
		// Load the optional user standard library (-l / standardLibrary): its named
		// exports override the built-in stdlib by being splatted onto globalThis
		// *after* it, while still being shadowed by anything a declaration block
		// declares or imports (those live in the generated module's scope). Done
		// inside the try so a load failure is still cleaned up by the finally below.
		if (standardLibrary)
		{
			let standardLibraryModule;
			try
			{
				standardLibraryModule = await import(pathToFileURL(resolvePath(standardLibrary)).href);
			}
			catch (ex)
			{
				throw new Error(`Couldn't load the standard library "${standardLibrary}": ${ex.message}`);
			}

			for (const [key, value] of Object.entries(standardLibraryModule))
			{
				if (key === "default") continue;
				if (POST_COMPILE_HOOKS.includes(key))
				{
					standardLibraryHooks[key] = value;
					continue;
				}
				setGlobal(key, value);
			}
		}

		// Build the grammar for this input's hash depth and make it active before
		// any matching. Desugaring only ever reduces hash depth, so the same
		// grammar parses both the original input and the desugared output.
		useGrammar(maxHashDepth(input));

		// In raw mode the whole document is treated as raw content (as if wrapped in
		// @{}): only @-calls are interpreted, everything else is literal. Both the
		// initial match and the post-desugar re-match use the rawDocument start rule
		// so the desugared output is re-parsed under the same raw semantics.
		const startRule = raw ? "rawDocument" : "document";
		const desugared = desugar(spruce.match(input, startRule));
		const desugaredMatch = spruce.match(desugared, startRule);
		const { codeToExecute, functionCallLocations, declarationBlockRanges, storageName } = getCode(desugaredMatch, outputFormat);
		// Write the fragment next to the document so its imports resolve relative to
		// the document's directory; fall back to the cwd when compiling without a path.
		const baseDir = filePath ? dirname(filePath) : process.cwd();
		const __spruceOutput = await runCode(codeToExecute, input, functionCallLocations, declarationBlockRanges, storageName, baseDir, filePath);
		let result = insertCodeOutput(desugaredMatch, __spruceOutput);

		const formatStdlib = stdlib[outputFormat];
		// A declaration block can shadow a post-compile hook by declaring or
		// importing its name; that override (if any) was ferried out on the
		// storage object and takes precedence over the stdlib default.
		const hookOverrides = __spruceOutput?.[HOOK_OVERRIDES_KEY] ?? {};
		for (const name of POST_COMPILE_HOOKS)
		{
			// Priority: declaration-block override > standard library > stdlib default.
			const hook = hookOverrides[name] ?? standardLibraryHooks[name] ?? formatStdlib?.[name];
			if (typeof hook === "function")
			{
				result = hook(result);
			}
		}

		return result;
	}
	finally
	{
		for (const entry of snapshot)
		{
			if (entry.had) globalThis[entry.key] = entry.value;
			else delete globalThis[entry.key];
		}
	}
}

// process.argv[1] may be a symlink (e.g. the `spruce` bin installed by
// `npm link`/`npm install -g`), so resolve it to the real path before
// comparing against this module's URL — otherwise the CLI silently no-ops.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
{
	const argv = process.argv.slice(2);
	const positional = [];
	let formatOverride = null;
	let rawMode = false;
	let preserveWs = false;
	let standardLibrary = null;

	for (let i = 0; i < argv.length; i++)
	{
		const arg = argv[i];
		if (arg === "-f" || arg === "--format")
		{
			formatOverride = argv[++i];
		}
		else if (arg === "-r" || arg === "--raw")
		{
			rawMode = true;
		}
		else if (arg === "-w" || arg === "--preserve-whitespace")
		{
			preserveWs = true;
		}
		else if (arg === "-l" || arg === "--standard-library")
		{
			standardLibrary = argv[++i];
		}
		else
		{
			positional.push(arg);
		}
	}

	const [inputPath, outputPath] = positional;

	if (!inputPath || !outputPath)
	{
		process.stderr.write("usage: spruce <input> <output> [-f|--format <format>] [-r|--raw] [-w|--preserve-whitespace] [-l|--standard-library <file>]\n");
		process.exit(1);
	}

	const outputFormat = formatOverride ?? extname(outputPath).slice(1).toLowerCase();

	const input = await readFile(inputPath, "utf-8");
	try
	{
		// Pass the absolute input path so post-compile hooks (e.g. `document`) get a
		// stable, fully-qualified path rather than whatever relative form the CLI
		// was invoked with.
		const result = await compile(input, outputFormat, {
			raw: rawMode,
			preserveWhitespace: preserveWs,
			filePath: resolvePath(inputPath),
			standardLibrary: standardLibrary ? resolvePath(standardLibrary) : null,
		});
		await writeFile(outputPath, result);
	}
	catch (ex)
	{
		// renderContext already printed the offending source line for runtime
		// errors; in that case skip the noisy JS stack and just fail. Otherwise
		// (parse errors, missing files, ...) surface the message.
		if (!ex.spruceContextRendered) process.stderr.write(`${ex.message ?? ex}\n`);
		process.exit(1);
	}
}