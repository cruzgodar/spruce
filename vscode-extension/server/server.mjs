import {
	CompletionItemKind,
	createConnection,
	DiagnosticSeverity,
	DiagnosticTag,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath } from "url";
import { collectTokens, tokenize, TOKEN_TYPES, TOKEN_MODIFIERS } from "./tokenizer.mjs";
import { buildImportEdits, collectCompletions, inScopeNames, resolveDefinition, unusedImportRanges } from "./completion.mjs";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Workspace roots, captured at initialize. Used to scan the workspace for
// auto-import candidates; the import specifiers themselves are generated relative
// to the document being edited (a declaration block's imports resolve against the
// document's own directory).
let workspaceRoots = [];

// Whether the client supports configuration pull (workspace/configuration). When
// it does, we read files.exclude/search.exclude and skip those files in the scan.
let hasConfigurationCapability = false;

// The merged set of enabled exclude globs from files.exclude + search.exclude,
// refreshed at initialize and whenever the client's configuration changes. Passed
// into collectCompletions so excluded files aren't offered as auto-imports.
let excludeGlobs = [];

// Read files.exclude/search.exclude and keep only the globs the user has enabled
// (value `true`; the conditional `{ when: ... }` form is skipped as unevaluable).
async function refreshExcludes() {
	if (!hasConfigurationCapability) return;
	try {
		const [filesExclude, searchExclude] = await Promise.all([
			connection.workspace.getConfiguration("files.exclude"),
			connection.workspace.getConfiguration("search.exclude"),
		]);
		const globs = new Set();
		for (const map of [filesExclude, searchExclude]) {
			if (map && typeof map === "object") {
				for (const [glob, on] of Object.entries(map)) {
					if (on === true) globs.add(glob);
				}
			}
		}
		excludeGlobs = [...globs];
	} catch (err) {
		connection.console.error(`exclude config failed: ${err && err.stack || err}`);
	}
}

connection.onInitialize((params) => {
	const folders = params.workspaceFolders;
	if (folders && folders.length) {
		workspaceRoots = folders.map((f) => fileURLToPath(f.uri));
	} else if (params.rootUri) {
		workspaceRoots = [fileURLToPath(params.rootUri)];
	}

	hasConfigurationCapability = Boolean(params.capabilities?.workspace?.configuration);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			semanticTokensProvider: {
				legend: {
					tokenTypes: TOKEN_TYPES,
					tokenModifiers: TOKEN_MODIFIERS,
				},
				range: false,
				full: true,
			},
			completionProvider: {
				// `@` opens a function call; Ctrl-Space still works inside declaration
				// blocks (and anywhere else) without a trigger character.
				triggerCharacters: ["@"],
				// Auto-import items defer their import edit to onCompletionResolve.
				resolveProvider: true,
			},
			// Cmd/Ctrl+click on an @function call (or a name in a declaration block)
			// jumps to its definition, the way VS Code does for JS.
			definitionProvider: true,
		},
	};
});

// Pull the exclude settings once the client is ready; re-pull on any config change
// (the auto-import scan reads excludeGlobs on its next run, so no cache busting is
// needed — collectWorkspaceExports keys its cache on the glob set).
connection.onInitialized(() => {
	refreshExcludes();
});

connection.onDidChangeConfiguration(() => {
	refreshExcludes();
});

// Resolve the identifier under the cursor to its definition: a declaration-block
// function/const in this document, an imported name's source-module export, or a
// reserved stdlib method. completion.mjs returns an LSP-ready { uri, range }.
connection.onDefinition((params) => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return null;
	try {
		const offset = doc.offsetAt(params.position);
		const filePath = params.textDocument.uri.startsWith("file:")
			? fileURLToPath(params.textDocument.uri)
			: null;
		return resolveDefinition(doc.getText(), offset, filePath);
	} catch (err) {
		connection.console.error(`definition failed: ${err && err.stack || err}`);
		return null;
	}
});

// Map completion.mjs's neutral kind strings onto LSP CompletionItemKinds.
const COMPLETION_KIND = {
	function: CompletionItemKind.Function,
	variable: CompletionItemKind.Variable,
	constant: CompletionItemKind.Constant,
	module: CompletionItemKind.Module,
};

connection.onCompletion((params) => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	try {
		const offset = doc.offsetAt(params.position);
		const filePath = params.textDocument.uri.startsWith("file:")
			? fileURLToPath(params.textDocument.uri)
			: null;
		return collectCompletions(doc.getText(), offset, { filePath, roots: workspaceRoots, excludes: excludeGlobs }).map((item) => ({
			label: item.label,
			kind: COMPLETION_KIND[item.kind] ?? CompletionItemKind.Text,
			detail: item.detail,
			// Locals (a function's parameters) sort above the document's module-scope
			// and reserved names, which in turn sort above the (potentially many)
			// auto-import options.
			sortText: `${item.autoImport ? "2" : item.local ? "0" : "1"}_${item.label}`,
			// Stash what onCompletionResolve needs to build the import edit. The doc
			// uri lets it re-read the current text; without an autoImport the field
			// is absent and resolve is a no-op.
			data: item.autoImport ? { uri: params.textDocument.uri, specifier: item.autoImport.specifier, name: item.label } : undefined,
		}));
	} catch (err) {
		connection.console.error(`completion failed: ${err && err.stack || err}`);
		return [];
	}
});

// When the user picks an auto-import item, compute the ESM import edit against
// the document's current text and attach it as an additional edit applied
// alongside the inserted name.
connection.onCompletionResolve((item) => {
	const data = item.data;
	if (!data || !data.specifier) return item;
	const doc = documents.get(data.uri);
	if (!doc) return item;
	try {
		const text = doc.getText();
		item.additionalTextEdits = buildImportEdits(text, data.specifier, data.name).map((edit) => ({
			range: { start: doc.positionAt(edit.start), end: doc.positionAt(edit.end) },
			newText: edit.newText,
		}));
	} catch (err) {
		connection.console.error(`completion resolve failed: ${err && err.stack || err}`);
	}
	return item;
});

connection.languages.semanticTokens.on((params) => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return { data: [] };
	try {
		const text = doc.getText();
		return { data: tokenize(text, inScopeNames(text)) };
	} catch (err) {
		connection.console.error(`tokenize failed: ${err && err.stack || err}`);
		return { data: [] };
	}
});

// Compute and publish diagnostics for a document: undefined @function calls as
// errors (so they surface in the Problems panel and the editor minimap, like a
// real compile error) and unused imports tagged Unnecessary (so VSCode dims
// them). Undefined calls are read off the semantic-token pass — the tokens it
// emits already carry correct absolute offsets, even inside re-matched parsed
// blocks — by filtering for the `undefinedFunction` type.
function publishDiagnostics(doc) {
	const text = doc.getText();
	const diagnostics = [];

	const known = inScopeNames(text);
	for (const tok of collectTokens(text, known)) {
		if (tok.type !== "undefinedFunction") continue;
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: { start: doc.positionAt(tok.start), end: doc.positionAt(tok.end) },
			message: `'${text.slice(tok.start, tok.end)}' is not defined.`,
			source: "spruce",
		});
	}

	for (const range of unusedImportRanges(text)) {
		diagnostics.push({
			severity: DiagnosticSeverity.Hint,
			tags: [DiagnosticTag.Unnecessary],
			range: { start: doc.positionAt(range.start), end: doc.positionAt(range.end) },
			message: "Unused import.",
			source: "spruce",
		});
	}

	connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidChangeContent((change) => {
	// Tell VSCode to refresh semantic tokens, and recompute diagnostics.
	connection.languages.semanticTokens.refresh();
	try {
		publishDiagnostics(change.document);
	} catch (err) {
		connection.console.error(`diagnostics failed: ${err && err.stack || err}`);
	}
});

documents.listen(connection);
connection.listen();
