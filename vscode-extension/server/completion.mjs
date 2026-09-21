// Completion logic for the Spruce language server, kept as a pure module (no LSP
// types) so it can be unit-tested directly; server.mjs maps the neutral items
// returned here onto LSP CompletionItems. Like tokenizer.mjs, this leans on the
// vendored stdlib.js copy (build-and-install.sh keeps it fresh).
//
// Completion contexts, matching how names resolve at compile time:
//   * Inside a `@@@ ... @@@` declaration block the body is plain JS, so bare
//     identifiers fall through to globalThis — we offer the reserved globals
//     (the format stdlib plus filePath/JSON5) alongside anything the document
//     has already defined or imported, plus the parameters of whichever
//     function(s) the cursor is nested in (see enclosingParameterNames).
//   * After an `@` function call we offer the reserved *functions* (the stdlib
//     renderers) plus the document's defined/imported names, since `@name`
//     invokes whatever `name` resolves to in module scope.
// In both contexts we also offer exports from any *not-yet-imported* JS file in
// the workspace; accepting one carries an auto-import edit (see buildImportEdits)
// that adds the ESM import to a declaration block.
import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { stdlib } from "./stdlib.js";

// Reserved names split by whether they're callable. Derived from the stdlib so
// new format functions show up automatically; unioned across formats because a
// document's output format isn't known while editing (the keys overlap anyway).
const reservedFunctions = new Map(); // name -> signature string, e.g. "(body)"
const reservedConstants = new Set(); // non-function stdlib names ($ and _)
for (const format of Object.values(stdlib)) {
	for (const [name, value] of Object.entries(format)) {
		if (typeof value === "function") {
			if (!reservedFunctions.has(name)) reservedFunctions.set(name, signatureOf(value));
		} else {
			reservedConstants.add(name);
		}
	}
}

// Format-independent globals splatted by spruce.js's _compileImpl: filePath (the
// document's absolute path) and JSON5 (the parser used for json-block arguments).
// Kept in step with the setGlobal calls there.
const EXTRA_GLOBALS = [
	{ label: "filePath", kind: "constant", detail: "absolute path of the current document" },
	{ label: "JSON5", kind: "module", detail: "JSON5 parser" },
];

// Every reserved name, regardless of context — used to keep auto-import
// suggestions from shadowing a built-in that's already in scope.
const RESERVED_NAMES = new Set([
	...reservedFunctions.keys(),
	...reservedConstants,
	...EXTRA_GLOBALS.map(g => g.label),
]);

// Pull the parameter list out of a function's source for display, e.g. a stdlib
// method `heading(body, headingNumber) { ... }` -> "(body, headingNumber)".
function signatureOf(fn) {
	const src = Function.prototype.toString.call(fn);
	const m = /^[^(]*\(([\s\S]*?)\)/.exec(src);
	return m ? `(${m[1].replace(/\s+/g, " ").trim()})` : "()";
}

function reservedGlobalItems() {
	const items = [];
	for (const [name, sig] of reservedFunctions) {
		items.push({ label: name, kind: "function", detail: `reserved ${sig}` });
	}
	for (const name of reservedConstants) {
		items.push({ label: name, kind: "constant", detail: "reserved" });
	}
	return items.concat(EXTRA_GLOBALS);
}

function reservedFunctionItems() {
	return [...reservedFunctions].map(([name, sig]) => ({ label: name, kind: "function", detail: `reserved ${sig}` }));
}

// Every `@@@ ... @@@` declaration block, as offsets into `text`: `openerStart`
// (start of the opener line), `bodyStart`/`bodyEnd` (the JS body between the
// opener line's newline and the closer line), and `tag` (the format after `@@@`,
// "" for a non-targeted block). The scan is line-based so it survives a document
// that doesn't fully parse mid-edit. A bare `@@@` line closes a block; a `@@@tag`
// line while already inside both closes the current block and opens the next (the
// grammar's soft terminator). An unterminated trailing block runs to end of
// document so completion still works while the closing fence is being typed.
function declarationBlocks(text) {
	const blocks = [];
	const fence = /^[ \t]*@@@[ \t]*([A-Za-z0-9]*)[ \t]*$/;
	let open = null;
	let pos = 0;
	for (const line of text.split("\n")) {
		const lineStart = pos;
		const nextStart = pos + line.length + 1; // +1 for the consumed "\n"
		// Strip a trailing "\r" so CRLF documents still match the fence regex.
		const m = fence.exec(line.replace(/\r$/, ""));
		if (m) {
			const tag = m[1];
			if (!open) {
				open = { openerStart: lineStart, bodyStart: nextStart, tag };
			} else if (tag === "") {
				blocks.push({ ...open, bodyEnd: lineStart });
				open = null;
			} else {
				blocks.push({ ...open, bodyEnd: lineStart });
				open = { openerStart: lineStart, bodyStart: nextStart, tag };
			}
		}
		pos = nextStart;
	}
	if (open) blocks.push({ ...open, bodyEnd: text.length });
	return blocks;
}

// The declaration block whose body contains `offset`, or null.
function declarationBlockAt(text, offset) {
	return declarationBlocks(text).find(b => offset >= b.bodyStart && offset <= b.bodyEnd) ?? null;
}

function inDeclarationBlock(text, offset) {
	return declarationBlockAt(text, offset) !== null;
}

// --- Local scope inside a declaration block ---------------------------------
//
// Module-scope names come out of definedNames above, but a cursor inside a
// function body also sees that function's parameters, and those are the names
// most worth offering there. Finding them means matching brackets in the block's
// JS, so everything below works on a copy with literals blanked out (a `{` in a
// string or a `//` in a URL would otherwise throw the matching off).

// `src` with the contents of comments, strings, template literals and regex
// literals replaced by spaces — delimiters included, newlines kept, and the same
// length as `src` so offsets still line up. Template interpolations stay intact:
// `${...}` holds real code, and a function can be declared in there.
function blankJsLiterals(src) {
	const out = src.split("");
	const blank = (from, to) => {
		for (let i = from; i < to && i < src.length; i++) {
			if (src[i] !== "\n" && src[i] !== "\r") out[i] = " ";
		}
	};

	// Brace depths at which each open `${` started, innermost last: when a `}`
	// brings the depth back to one of them, we're back inside its template.
	const interpolations = [];
	let depth = 0;
	let inTemplate = false;
	// The last code character that wasn't whitespace, which is what tells a regex
	// literal from a division (`replace(/x/)` vs `a / b`).
	let previous = "";
	let i = 0;

	while (i < src.length) {
		const c = src[i];

		if (inTemplate) {
			if (c === "\\") { blank(i, i + 2); i += 2; continue; }
			if (c === "`") { blank(i, i + 1); i += 1; inTemplate = false; previous = "`"; continue; }
			if (c === "$" && src[i + 1] === "{") {
				blank(i, i + 2);
				i += 2;
				interpolations.push(depth);
				depth++;
				inTemplate = false;
				previous = "{";
				continue;
			}
			blank(i, i + 1);
			i += 1;
			continue;
		}

		if (c === "/" && src[i + 1] === "/") {
			let end = i + 2;
			while (end < src.length && src[end] !== "\n" && src[end] !== "\r") end++;
			blank(i, end);
			i = end;
			continue;
		}

		if (c === "/" && src[i + 1] === "*") {
			const close = src.indexOf("*/", i + 2);
			const end = close === -1 ? src.length : close + 2;
			blank(i, end);
			i = end;
			continue;
		}

		if (c === '"' || c === "'") {
			let end = i + 1;
			while (end < src.length && src[end] !== c) {
				if (src[end] === "\\") end++;
				end++;
			}
			blank(i, Math.min(end + 1, src.length));
			i = end + 1;
			previous = c;
			continue;
		}

		if (c === "`") {
			blank(i, i + 1);
			i += 1;
			inTemplate = true;
			continue;
		}

		if (c === "/" && regexAllowedAfter(previous)) {
			let end = i + 1;
			let inClass = false;
			while (end < src.length && !(src[end] === "/" && !inClass)) {
				if (src[end] === "\\") end++;
				else if (src[end] === "[") inClass = true;
				else if (src[end] === "]") inClass = false;
				else if (src[end] === "\n") break;
				end++;
			}
			blank(i, Math.min(end + 1, src.length));
			i = end + 1;
			previous = "/";
			continue;
		}

		if (c === "{") depth++;
		if (c === "}") {
			depth--;
			if (interpolations.length && depth === interpolations[interpolations.length - 1]) {
				interpolations.pop();
				inTemplate = true;
				i += 1;
				continue;
			}
		}

		if (!/\s/.test(c)) previous = c;
		i += 1;
	}

	return out.join("");
}

// Whether a `/` after `previous` opens a regex literal rather than dividing.
// Only the punctuation cases are covered; a regex right after a keyword
// (`return /x/`) reads as division here, which at worst blanks a stretch of code
// and costs a few completions.
function regexAllowedAfter(previous) {
	return previous === "" || "(,=:[!&|?{};+-*%~^<>".includes(previous);
}

const BRACKET_CLOSERS = { "(": ")", "[": "]", "{": "}" };

// For each opening bracket in `code` (already literal-blanked), the index of the
// one that closes it, or -1. Built in a single pass so the scope search below
// can look a match up per candidate header instead of rescanning the source.
function bracketMatches(code) {
	const matches = new Int32Array(code.length).fill(-1);
	const open = [];
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "[" || c === "{") open.push(i);
		else if (c === ")" || c === "]" || c === "}") {
			const start = open.pop();
			if (start !== undefined && BRACKET_CLOSERS[code[start]] === c) matches[start] = i;
		}
	}
	return matches;
}

// Index of the next non-whitespace character at or after `from`, or -1.
function nextSignificant(code, from) {
	for (let i = from; i < code.length; i++) {
		if (!/\s/.test(code[i])) return i;
	}
	return -1;
}

// The identifier ending just before `i`, ignoring spaces and tabs, or "". Read
// backwards rather than by matching `code.slice(0, i)`, which would copy the
// whole block once per candidate header.
function wordBefore(code, i) {
	let end = i;
	while (end > 0 && (code[end - 1] === " " || code[end - 1] === "\t")) end--;
	let start = end;
	while (start > 0 && /[\w$]/.test(code[start - 1])) start--;
	return code.slice(start, end);
}

// Keywords whose `(...)` is a condition or binding, not a parameter list. The
// remaining `name(...) {` shapes — a function declaration, a method shorthand,
// a `function (...)` expression — really do take parameters.
const NON_FUNCTION_HEADS = new Set(["if", "for", "while", "switch", "catch", "with", "do", "else", "return"]);

// Split `source` on top-level `separator`, ignoring any inside brackets.
function splitTopLevel(source, separator = ",") {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === separator && depth === 0) {
			parts.push(source.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(source.slice(start));
	return parts;
}

// Index of the first top-level `:` in `source`, or -1. Used to tell a
// destructuring key from the binding it renames.
function topLevelColon(source) {
	let depth = 0;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === ":" && depth === 0) return i;
	}
	return -1;
}

// `source` with any top-level default value (`= ...`) removed, so only the bound
// name is left. `=>` and the comparison operators are skipped so an arrow or a
// comparison inside a default can't be mistaken for the assignment.
function stripDefault(source) {
	let depth = 0;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "=" && depth === 0) {
			if (source[i + 1] === "=" || source[i + 1] === ">") return source.slice(0, i);
			if ("=!<>".includes(source[i - 1])) continue;
			return source.slice(0, i);
		}
	}
	return source;
}

// Every name a binding pattern introduces, pushed onto `out`: a plain
// identifier, the aliases and shorthand keys of an object pattern, the elements
// of an array pattern, and rest elements. Default *values* are dropped, so
// `{ a = fallback(b) }` binds only `a`.
function patternNames(source, out) {
	const pattern = stripDefault(source).trim().replace(/^\.\.\./, "").trim();
	if (!pattern) return;

	if (pattern.startsWith("{") || pattern.startsWith("[")) {
		for (const part of splitTopLevel(pattern.slice(1, -1))) {
			const colon = pattern.startsWith("{") ? topLevelColon(part) : -1;
			patternNames(colon === -1 ? part : part.slice(colon + 1), out);
		}
		return;
	}

	if (/^[A-Za-z_$][\w$]*$/.test(pattern)) out.push(pattern);
}

// The parameter names bound by every function in `body` whose own body encloses
// `offset`, outermost first and deduped. `body` is a declaration block's JS and
// `offset` is relative to it.
function enclosingParameterNames(body, offset) {
	const code = blankJsLiterals(body);
	const matches = bracketMatches(code);
	const names = [];
	const seen = new Set();

	const claim = (paramsStart, paramsEnd, scopeStart, scopeEnd) => {
		if (offset <= scopeStart || offset > scopeEnd) return;
		const found = [];
		for (const part of splitTopLevel(code.slice(paramsStart, paramsEnd))) patternNames(part, found);
		for (const name of found) {
			if (seen.has(name)) continue;
			seen.add(name);
			names.push(name);
		}
	};

	// The scope a function header at `from` opens: a braced body, or the rest of
	// a concise arrow's expression (to the next top-level , or ; or the close of
	// whatever encloses it).
	const scopeAfter = (from) => {
		const at = nextSignificant(code, from);
		if (at === -1) return null;
		if (code[at] === "{") {
			const end = matches[at];
			return { start: at, end: end === -1 ? code.length : end };
		}
		let depth = 0;
		for (let i = at; i < code.length; i++) {
			const c = code[i];
			if (c === "(" || c === "[" || c === "{") depth++;
			else if (c === ")" || c === "]" || c === "}") {
				if (depth === 0) return { start: at - 1, end: i };
				depth--;
			} else if ((c === "," || c === ";") && depth === 0) return { start: at - 1, end: i };
		}
		return { start: at - 1, end: code.length };
	};

	for (let i = 0; i < code.length; i++) {
		if (code[i] !== "(") continue;
		const close = matches[i];
		if (close === -1) continue;
		const after = nextSignificant(code, close + 1);
		if (after === -1) continue;

		if (code.startsWith("=>", after)) {
			const scope = scopeAfter(after + 2);
			if (scope) claim(i + 1, close, scope.start, scope.end);
			continue;
		}

		// `head(...) {` — a function only when `head` isn't a control keyword.
		if (code[after] !== "{") continue;
		if (NON_FUNCTION_HEADS.has(wordBefore(code, i))) continue;
		const end = matches[after];
		claim(i + 1, close, after, end === -1 ? code.length : end);
	}

	// `param => ...`, the one arrow form with no parentheses to key off. The
	// leading character keeps this off a `)` or `]` (already handled above) and
	// off a property access.
	for (const m of code.matchAll(/(^|[^\w$.)\]])([A-Za-z_$][\w$]*)[ \t]*=>/g)) {
		const nameStart = m.index + m[1].length;
		const scope = scopeAfter(m.index + m[0].length);
		if (scope) claim(nameStart, nameStart + m[2].length, scope.start, scope.end);
	}

	return names;
}

// Completion items for the parameters in scope at `offset`, or [] when the
// cursor isn't inside a declaration block's function.
function parameterItems(text, offset) {
	const block = declarationBlockAt(text, offset);
	if (!block) return [];
	const body = text.slice(block.bodyStart, block.bodyEnd);
	// `local` marks these as the innermost binding, which server.mjs sorts above
	// the module-scope and auto-import entries.
	return enclosingParameterNames(body, offset - block.bodyStart)
		.map(name => ({ label: name, kind: "variable", detail: "parameter", local: true }));
}

// The identifier prefix of a `@name` call ending at `offset`, or null when the
// cursor isn't in call position. Rejects `@@@` (declaration fence) and `@@`
// (escaped @) so those don't trigger function completion.
function callPrefix(text, offset) {
	let i = offset;
	while (i > 0 && /[A-Za-z0-9_$]/.test(text[i - 1])) i--;
	if (text[i - 1] !== "@") return null;
	if (text[i - 2] === "@") return null;
	return text.slice(i, offset);
}

const FUNC_DECL = /(?:^|[\s;}])(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
const VAR_FUNC = /(?:^|[\s;}])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
const VAR_ANY = /(?:^|[\s;}])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
const IMPORT_STMT = /\bimport\s+([^;'"]*?)\s+from\s*["']([^"']+)["']/g;

// Names the document makes available in module scope: top-level function/const
// declarations in any declaration block, and every binding of an
// `import ... from` statement. Returned as a name -> item Map so callers can
// dedupe; functions win over plain variables when a name appears both ways.
function definedNames(text, filePath) {
	const items = new Map();
	const add = (name, kind, detail) => {
		const existing = items.get(name);
		if (existing && (existing.kind === "function" || kind !== "function")) return;
		items.set(name, { label: name, kind, detail });
	};

	for (const { bodyStart, bodyEnd } of declarationBlocks(text)) {
		const body = text.slice(bodyStart, bodyEnd);
		for (const m of body.matchAll(FUNC_DECL)) add(m[1], "function", "defined in document");
		for (const m of body.matchAll(VAR_FUNC)) add(m[1], "function", "defined in document");
		for (const m of body.matchAll(VAR_ANY)) add(m[1], "variable", "defined in document");

		for (const m of body.matchAll(IMPORT_STMT)) {
			const kinds = new Map(moduleExports(m[2], filePath).map(e => [e.label, e.kind]));
			for (const { local, imported } of parseImportClause(m[1])) {
				const kind = imported && imported !== "default" ? (kinds.get(imported) ?? "variable") : "variable";
				add(local, kind, `imported from ${m[2]}`);
			}
		}
	}

	return items;
}

// Every name that resolves in `text`'s module scope: the reserved stdlib names
// (functions, constants, and injected globals) plus everything the document
// defines or imports. A bare `@name` call whose name isn't in this set resolves
// to nothing, so the tokenizer flags it as an undefined function. Name-only and
// side-effect-free (no module exports are read), so it's cheap to call per edit.
export function inScopeNames(text) {
	const names = new Set(RESERVED_NAMES);
	for (const name of definedNames(text, null).keys()) names.add(name);
	return names;
}

// The source ranges (absolute offsets) of unused imports — a local name that
// never appears anywhere outside the import statements themselves (not as an
// `@name` call, not referenced in declaration JS). The server marks these with
// the Unnecessary tag so VSCode dims them, the way it grays unused JS imports.
// When every binding of a statement is unused the whole statement is returned;
// when only some are, each unused binding's own name range is returned (matching
// how VSCode dims individual unused specifiers). Per-binding ranges are produced
// for named-group bindings (`{ a, b }`); a lone default/namespace binding is
// only dimmed via the whole-statement (all-unused) case.
export function unusedImportRanges(text) {
	const stmts = importStatements(text);
	if (stmts.length === 0) return [];

	// A binding counts as used in two distinct ways, and we must not conflate them:
	//   * In declaration-block JS, a bare reference (`name`) is a real use.
	//   * In the markdown body, only an `@name` call is a use — the bare name
	//     showing up as ordinary prose or inside a parsed block (e.g. a `/debug/...`
	//     URL) is NOT a use, and must not keep an unused `debug` import alive.
	// So we split the text into two corpora (with import statements blanked, so a
	// binding never counts itself) and search each with the rule that fits it.
	const declChars = text.split("");
	const mdChars = text.split("");
	const inDecl = new Uint8Array(text.length);
	for (const { bodyStart, bodyEnd } of declarationBlocks(text)) {
		for (let i = bodyStart; i < bodyEnd && i < text.length; i++) inDecl[i] = 1;
	}
	// Each char belongs to exactly one corpus; blank it out of the other so a
	// declaration name can't bleed into the markdown scan or vice versa.
	for (let i = 0; i < text.length; i++) {
		if (inDecl[i]) mdChars[i] = " ";
		else declChars[i] = " ";
	}
	// Blank import statements out of the declaration corpus so a binding only
	// counts when it's referenced somewhere other than its own import.
	for (const s of stmts) for (let i = s.start; i < s.end; i++) declChars[i] = " ";
	const declJs = declChars.join("");
	const markdown = mdChars.join("");

	// In markdown, require a leading `@` (and reject `@@name`, an escaped @) so only
	// genuine calls count; in declaration JS, a bare word reference counts. A
	// built-in (stdlib) name is never treated as unused, even if the document
	// never references it.
	const isUsed = name =>
		RESERVED_NAMES.has(name) ||
		new RegExp(`\\b${escapeRe(name)}\\b`).test(declJs) ||
		new RegExp(`(?<!@)@[ \\t]*${escapeRe(name)}\\b`).test(markdown);

	const ranges = [];
	for (const s of stmts) {
		const unused = s.locals.filter(name => !isUsed(name));
		if (unused.length === 0) continue;
		if (unused.length === s.locals.length) {
			ranges.push({ start: s.start, end: s.end });
		} else {
			for (const b of s.named) {
				if (!isUsed(b.local)) ranges.push({ start: b.nameStart, end: b.nameEnd });
			}
		}
	}
	return ranges;
}

// Every import statement in the document's declaration blocks, with absolute
// offsets: `start`/`end` span the whole statement, `locals` is every binding's
// local name, and `named` carries the `{ ... }`-group bindings with the absolute
// range of each local name token (used for per-binding dimming).
function importStatements(text) {
	const out = [];
	for (const { bodyStart, bodyEnd } of declarationBlocks(text)) {
		const body = text.slice(bodyStart, bodyEnd);
		for (const m of body.matchAll(IMPORT_STMT)) {
			const start = bodyStart + m.index;
			const clauseBase = start + /^import\s+/.exec(m[0])[0].length;
			out.push({
				start,
				end: start + m[0].length,
				locals: parseImportClause(m[1]).map(b => b.local),
				named: namedBindingRanges(m[1], clauseBase),
			});
		}
	}
	return out;
}

// The `{ ... }`-group bindings of an import clause, each with the absolute range
// of its local name (the alias when one is present). `clauseBase` is the
// absolute offset of the clause's first character.
function namedBindingRanges(clause, clauseBase) {
	const out = [];
	const group = /\{([^}]*)\}/.exec(clause);
	if (!group) return out;
	const contentBase = clauseBase + group.index + 1; // past the "{"
	const re = /([A-Za-z_$][\w$]*)(\s+as\s+([A-Za-z_$][\w$]*))?/g;
	let m;
	while ((m = re.exec(group[1]))) {
		const local = m[3] || m[1];
		// The alias (m[3]) sits after the name and the " as " connector; otherwise
		// the binding name is the local itself.
		const rel = m[3] ? m.index + m[1].length + (m[2].length - m[3].length) : m.index;
		const nameStart = contentBase + rel;
		out.push({ local, nameStart, nameEnd: nameStart + local.length });
	}
	return out;
}

// Local bindings introduced by an `import` clause (the text between `import` and
// `from`), each as { local, imported }: `imported` is the source export name,
// "default" for a default import, or null for a `* as ns` namespace import.
function parseImportClause(clause) {
	const bindings = [];
	const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
	if (ns) bindings.push({ local: ns[1], imported: null });

	const group = /\{([^}]*)\}/.exec(clause);
	if (group) {
		for (const part of group[1].split(",")) {
			const seg = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
			if (seg) bindings.push({ local: seg[2] || seg[1], imported: seg[1] });
		}
	}

	const head = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[\w$]+/, "").replace(/,/g, " ").trim();
	const def = /^([\w$]+)$/.exec(head);
	if (def) bindings.push({ local: def[1], imported: "default" });

	return bindings;
}

// The filesystem path an import specifier resolves to, mirroring how the
// compiler resolves a declaration block's imports: relative specifiers resolve
// against the document's own directory (the compiler writes its fragment there),
// and an absolute "/x" specifier is a filesystem-absolute path. Bare specifiers
// (node packages) are left to default resolution and skipped here.
function importCandidate(specifier, filePath) {
	if (specifier.startsWith("/")) return specifier;
	if (specifier.startsWith(".") && filePath) return resolvePath(dirname(filePath), specifier);
	return null;
}

// Resolve a specifier to a file and statically read its named exports, or [] if
// it can't be resolved/read. Wraps extractExports for the import code path.
function moduleExports(specifier, filePath) {
	const candidate = importCandidate(specifier, filePath);
	if (!candidate) return [];
	try {
		return extractExports(readFileSync(candidate, "utf8"));
	} catch {
		return [];
	}
}

// Statically read a module's named exports without executing it (the LSP must
// stay side-effect-free): function/const exports and re-export lists. Default
// exports aren't usable as bare names, so they're dropped.
function extractExports(src) {
	const items = new Map();
	for (const m of src.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
		items.set(m[1], { label: m[1], kind: "function" });
	}
	for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)?/g)) {
		if (!items.has(m[1])) items.set(m[1], { label: m[1], kind: m[2] ? "function" : "variable" });
	}
	for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
		for (const part of m[1].split(",")) {
			const seg = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
			if (!seg) continue;
			const name = seg[2] || seg[1];
			if (name === "default" || items.has(name)) continue;
			items.set(name, { label: name, kind: "function" });
		}
	}
	return [...items.values()];
}

// --- Workspace scan for auto-import candidates -----------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);
const MAX_FILES = 1500;

// Convert a VS Code exclude glob (a `files.exclude`/`search.exclude` key) to a
// RegExp anchored to a workspace-root-relative POSIX path. Supports the subset VS
// Code's settings use: `**` (any depth, including none across a following `/`),
// `*`, `?`, and `{a,b}` brace alternations, plus literal path separators.
function globToRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?"; // `**/` spans any number of leading dirs (including none)
				} else {
					re += ".*";
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (c === "{") {
			re += "(?:";
		} else if (c === "}") {
			re += ")";
		} else if (c === ",") {
			re += "|";
		} else if (".+^$()|[]\\/".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp("^" + re + "$");
}

// Compile a list of exclude globs into matchers over root-relative POSIX paths:
// `fileRes` tests a file path, `dirRes` tests a directory path (a `dir/**`-style
// glob is stripped to its prefix so the directory itself prunes the whole subtree).
function compileExcludes(globs) {
	const fileRes = [];
	const dirRes = [];
	for (const g of globs) {
		if (!g) continue;
		fileRes.push(globToRegExp(g));
		dirRes.push(globToRegExp(g.replace(/\/\*\*$/, "")));
	}
	return { fileRes, dirRes };
}

function matchesAny(res, path) {
	return res.some(re => re.test(path));
}

// A `./`- or `../`-relative specifier from the document's directory to a file,
// using POSIX separators (what an ESM import wants). Declaration-block imports
// resolve against the document's own directory, so a doc-relative path is what
// actually resolves at compile time.
function relSpecifier(fromDir, file) {
	let rel = relative(fromDir, file).split(sep).join("/");
	if (!rel.startsWith(".")) rel = "./" + rel;
	return rel;
}

// `root` is the workspace root this walk descends from; `exclude` is the compiled
// matcher (or null) used to honor VS Code's files.exclude/search.exclude settings.
// Both directories and files are tested against it on their root-relative path.
function walkJsFiles(dir, out, budget, root, exclude) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (budget.count >= MAX_FILES) return;
		if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
		const full = join(dir, entry.name);
		const rel = relative(root, full).split(sep).join("/");
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			if (exclude && matchesAny(exclude.dirRes, rel)) continue;
			walkJsFiles(full, out, budget, root, exclude);
		} else if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) {
			if (exclude && matchesAny(exclude.fileRes, rel)) continue;
			budget.count++;
			let src;
			try {
				src = readFileSync(full, "utf8");
			} catch {
				continue;
			}
			// Store the absolute path; the import specifier is computed per document
			// (relative to whichever file is being edited) when items are built.
			for (const exp of extractExports(src)) {
				out.push({ label: exp.label, kind: exp.kind, file: full });
			}
		}
	}
}

// Walking the tree on every keystroke would be wasteful; the client filters a
// returned list locally as the user types, so a short TTL cache is plenty.
let exportCache = { key: null, time: 0, items: [] };

function collectWorkspaceExports(roots, excludes = []) {
	const key = roots.join("\0") + "" + excludes.join("\0");
	const now = Date.now();
	if (exportCache.key === key && now - exportCache.time < 5000) return exportCache.items;

	const exclude = excludes.length ? compileExcludes(excludes) : null;
	const items = [];
	const budget = { count: 0 };
	for (const root of roots) walkJsFiles(root, items, budget, root, exclude);

	exportCache = { key, time: now, items };
	return items;
}

// --- Auto-import edit -------------------------------------------------------

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One indentation step for the document, inferred from the first indented line:
// a leading tab means tabs (one tab per step), otherwise the leading run of
// spaces is taken as one step. Falls back to a single tab when nothing in the
// document is indented yet.
function detectIndent(text) {
	const m = /^([ \t]+)\S/m.exec(text);
	if (!m) return "\t";
	return m[1][0] === "\t" ? "\t" : m[1];
}

// A blank-line insertion edit (or none) keeping one blank line between the edited
// import line (ending at `body[lineEnd - 1]` === "\n") and the next statement, if
// any. No-op when they're already separated, or when the import is the last
// non-blank line in the block (the declaration block ends on the following line).
function blankLineSeparatorEdits(body, bodyStart, lineEnd) {
	const rest = body.slice(lineEnd);
	if (rest.trim() === "" || rest.startsWith("\n")) return [];
	const at = bodyStart + lineEnd;
	return [{ start: at, end: at, newText: "\n" }];
}

// Sort key for a named-import binding: the imported (source) name, so `x as y`
// orders by `x`. Falls back to the whole segment for anything unparseable.
function bindingKey(segment) {
	return /^([A-Za-z_$][\w$]*)/.exec(segment)?.[1] ?? segment;
}

// The module specifier of a single import line, used to order the import run.
function specifierOf(importLine) {
	return /from\s*["']([^"']+)["']/.exec(importLine)?.[1] ?? "";
}

// The text edits (offset-based, for server.mjs to turn into LSP TextEdits) that
// add `import { name } from "<specifier>"` to the document. Per the requested
// behavior we always target a *non-targeted* (`@@@` with no format) declaration
// block: extend an existing import from the same specifier, else add an import
// line at the top of the first such block, else create a new block at the top of
// the document. Whenever an import is added, the affected group is re-sorted
// alphabetically — the named bindings within a `{ ... }` group, and the run of
// import lines (by module specifier). A blank line is kept between the import
// group and the first non-import statement (and none when there isn't one).
// Returns [] when the name is already imported from that specifier.
export function buildImportEdits(text, specifier, name) {
	const blocks = declarationBlocks(text).filter(b => b.tag === "");
	const indent = detectIndent(text);
	const importLine = `${indent}import { ${name} } from "${specifier}";`;

	if (blocks.length === 0) {
		return [{ start: 0, end: 0, newText: `@@@\n${importLine}\n@@@\n\n` }];
	}

	const importRe = new RegExp(`import\\s+(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${escapeRe(specifier)}["']`);
	for (const block of blocks) {
		const body = text.slice(block.bodyStart, block.bodyEnd);
		const m = importRe.exec(body);
		if (!m) continue;

		if (new RegExp(`\\b${escapeRe(name)}\\b`).test(m[1])) return []; // already imported

		// Rebuild the named group with the new binding, sorted alphabetically, and
		// replace the whole `{ ... }` span. Replacing the span (rather than inserting)
		// lets us re-sort any previously out-of-order bindings in the same edit.
		const bindings = m[1].split(",").map(s => s.trim()).filter(Boolean);
		bindings.push(name);
		bindings.sort((a, b) => bindingKey(a).localeCompare(bindingKey(b)));
		const groupStart = block.bodyStart + m.index + m[0].indexOf("{");
		const groupEnd = block.bodyStart + m.index + m[0].indexOf("}") + 1;
		const nl = body.indexOf("\n", m.index + m[0].length);
		const lineEnd = nl === -1 ? body.length : nl + 1;
		// The group replace and the (offset-disjoint) blank-line separator both land
		// in this block; return them together.
		return [
			{ start: groupStart, end: groupEnd, newText: `{ ${bindings.join(", ")} }` },
			...blankLineSeparatorEdits(body, block.bodyStart, lineEnd),
		];
	}

	// No import from this specifier yet: add a line to the first block's import run
	// and re-sort the run by specifier, keeping a blank line before any following
	// code. Replacing the whole run as one edit keeps the sort and the separator
	// from colliding at a shared offset.
	const block = blocks[0];
	const body = text.slice(block.bodyStart, block.bodyEnd);
	const lines = body.split("\n");

	let runChars = 0;
	let i = 0;
	const importLines = [];
	for (; i < lines.length; i++) {
		if (!/^[ \t]*import\b/.test(lines[i])) break;
		importLines.push(lines[i]);
		runChars += lines[i].length + 1; // include the consumed "\n"
	}
	importLines.push(importLine);
	importLines.sort((a, b) => specifierOf(a).localeCompare(specifierOf(b)));

	const followingIsBlank = lines[i] !== undefined && lines[i].trim() === "";
	const hasCodeAfter = lines.slice(i).some(l => l.trim() !== "");
	const needsBlank = hasCodeAfter && !followingIsBlank;

	const start = block.bodyStart;
	const end = block.bodyStart + runChars; // past the last import line's newline (== start when none)
	const newText = importLines.join("\n") + "\n" + (needsBlank ? "\n" : "");
	return [{ start, end, newText }];
}

// Merge reserved items with the document's defined names, dropping any reserved
// entry the document redefines (a user override shadows the built-in).
function withDefined(reserved, defined) {
	const out = reserved.filter(item => !defined.has(item.label));
	return out.concat([...defined.values()]);
}

// Workspace exports for names not already in scope, deduped by name+specifier so
// the same symbol from two files stays distinguishable. Each carries `autoImport`
// (the specifier) so the server can attach the import edit on accept. The
// specifier is computed relative to the document being edited; without a file
// path we can't form a resolvable relative import, so no auto-imports are
// offered.
function autoImportItems(defined, roots, filePath, excludes) {
	if (!filePath) return [];
	const fromDir = dirname(filePath);
	const seen = new Set();
	const items = [];
	for (const exp of collectWorkspaceExports(roots, excludes)) {
		if (RESERVED_NAMES.has(exp.label) || defined.has(exp.label)) continue;
		const specifier = relSpecifier(fromDir, exp.file);
		const key = `${exp.label}\0${specifier}`;
		if (seen.has(key)) continue;
		seen.add(key);
		items.push({
			label: exp.label,
			kind: exp.kind,
			detail: `auto-import from ${specifier}`,
			autoImport: { specifier },
		});
	}
	return items;
}

// --- Go-to-definition -------------------------------------------------------

// Expand to the identifier covering `offset` (a cursor at either edge counts as
// inside it, matching how an editor resolves a click), or null when none is there.
function identifierAt(text, offset) {
	const isPart = c => c !== undefined && /[A-Za-z0-9_$]/.test(c);
	let start = offset;
	let end = offset;
	while (start > 0 && isPart(text[start - 1])) start--;
	while (end < text.length && isPart(text[end])) end++;
	if (start === end) return null;
	return { name: text.slice(start, end), start, end };
}

// Line/character (0-based, LSP style) of an absolute offset in `text`.
function offsetToPosition(text, offset) {
	let line = 0;
	let lineStart = 0;
	const limit = Math.min(offset, text.length);
	for (let i = 0; i < limit; i++) {
		if (text[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, character: offset - lineStart };
}

// An LSP-style { uri, range } spanning the `name` token at `offset` in the file
// `targetPath` (whose contents are `src`).
function definitionLocation(targetPath, src, offset, name) {
	return {
		uri: pathToFileURL(targetPath).href,
		range: {
			start: offsetToPosition(src, offset),
			end: offsetToPosition(src, offset + name.length),
		},
	};
}

// Offset of the declaration of `name` in JS source `src` — a function/const/let/
// var/class declaration — or -1 when `name` isn't declared there. The same shapes
// extractExports recognizes, located rather than just named.
function declarationOffset(src, name) {
	const n = escapeRe(name);
	const decls = [
		new RegExp(`(?:^|[\\s;}])(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${n})\\b`),
		new RegExp(`(?:^|[\\s;}])(?:export\\s+)?(?:const|let|var)\\s+(${n})\\b`),
		new RegExp(`(?:^|[\\s;}])(?:export\\s+)?class\\s+(${n})\\b`),
	];
	for (const re of decls) {
		const m = re.exec(src);
		if (m) return m.index + m[0].lastIndexOf(name);
	}
	return -1;
}

// The import that binds `local` somewhere in the document's declaration blocks,
// as { specifier, imported, nameOffset }, or null when `local` isn't imported.
// `nameOffset` (the absolute offset of the local binding token) lets a jump fall
// back to the import line when the source module can't be resolved.
function importBinding(text, local) {
	for (const { bodyStart, bodyEnd } of declarationBlocks(text)) {
		const body = text.slice(bodyStart, bodyEnd);
		for (const m of body.matchAll(IMPORT_STMT)) {
			for (const b of parseImportClause(m[1])) {
				if (b.local !== local) continue;
				const clauseStart = bodyStart + m.index + /^import\s+/.exec(m[0])[0].length;
				const rel = m[1].lastIndexOf(local);
				return {
					specifier: m[2],
					imported: b.imported,
					nameOffset: rel >= 0 ? clauseStart + rel : bodyStart + m.index,
				};
			}
		}
	}
	return null;
}

// The vendored stdlib.js, read lazily and cached, alongside its path. The module
// sits next to this one (build-and-install.sh keeps the copy fresh).
let stdlibFile;
function stdlibSource() {
	if (stdlibFile === undefined) {
		try {
			const path = fileURLToPath(new URL("./stdlib.js", import.meta.url));
			stdlibFile = { path, src: readFileSync(path, "utf8") };
		} catch {
			stdlibFile = null;
		}
	}
	return stdlibFile;
}

// Definition location of a reserved name inside the vendored stdlib.js: a method
// shorthand (`heading(body) { ... }`) for functions, a property (`$: "$"`) for
// constants. Returns null for non-reserved names or when stdlib.js can't be read.
function stdlibDefinition(name) {
	if (!reservedFunctions.has(name) && !reservedConstants.has(name)) return null;
	const s = stdlibSource();
	if (!s) return null;
	const n = escapeRe(name);
	const re = reservedConstants.has(name)
		? new RegExp(`(?:^|[\\s{,])(${n})\\s*:`, "m")
		: new RegExp(`(?:^|[\\s{,])(${n})\\s*\\(`, "m");
	const m = re.exec(s.src);
	if (!m) return null;
	return definitionLocation(s.path, s.src, m.index + m[0].lastIndexOf(name), name);
}

// Resolve the identifier under `offset` to its definition, as an LSP-style
// { uri, range }, or null. Resolution mirrors how names bind at compile time:
// a declaration-block function/const/etc. in the document wins, then an imported
// name (jumping to the source module's export, or the import line when the module
// can't be read), then a reserved stdlib name (jumping to the vendored stdlib.js).
export function resolveDefinition(text, offset, filePath = null) {
	const id = identifierAt(text, offset);
	if (!id) return null;
	const { name } = id;

	// 1) Declared in one of the document's own declaration blocks.
	if (filePath) {
		for (const { bodyStart, bodyEnd } of declarationBlocks(text)) {
			const rel = declarationOffset(text.slice(bodyStart, bodyEnd), name);
			if (rel >= 0) return definitionLocation(filePath, text, bodyStart + rel, name);
		}
	}

	// 2) Imported -> the source module's export, else the import binding itself.
	const binding = importBinding(text, name);
	if (binding) {
		const sourceName = binding.imported && binding.imported !== "default" ? binding.imported : name;
		const candidate = importCandidate(binding.specifier, filePath);
		if (candidate) {
			try {
				const src = readFileSync(candidate, "utf8");
				const rel = declarationOffset(src, sourceName);
				if (rel >= 0) return definitionLocation(candidate, src, rel, sourceName);
			} catch {
				// Unresolvable/unreadable module: fall through to the import line.
			}
		}
		return filePath ? definitionLocation(filePath, text, binding.nameOffset, name) : null;
	}

	// 3) A reserved stdlib name.
	return stdlibDefinition(name);
}

// Returns neutral completion items for the cursor at `offset`, or [] when the
// cursor isn't in a completion context. Auto-import items carry an `autoImport`
// field; the rest are plain { label, kind, detail }.
export function collectCompletions(text, offset, { filePath = null, roots = [], excludes = [] } = {}) {
	const defined = definedNames(text, filePath);

	let items;
	// Parameters of the function(s) the cursor sits in. Only a declaration block
	// has them, and they're the innermost binding, so they shadow everything else.
	let scoped = [];
	if (inDeclarationBlock(text, offset)) {
		scoped = parameterItems(text, offset);
		items = withDefined(reservedGlobalItems(), defined);
	} else if (callPrefix(text, offset) !== null) {
		items = withDefined(reservedFunctionItems(), defined);
	} else {
		return [];
	}

	const shadowed = new Set(scoped.map(item => item.label));
	return scoped.concat(
		items.concat(autoImportItems(defined, roots, filePath, excludes)).filter(item => !shadowed.has(item.label))
	);
}
