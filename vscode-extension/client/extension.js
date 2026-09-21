const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const { DECLARATION, MARKUP, contextAt } = require("../server/context.mjs");

let client;

// Auto-closing pairs that hold everywhere: the block delimiters open something
// in every context — a markup or raw block, a json argument, an object literal
// in a declaration block's JS.
const BRACKET_PAIRS = [
	{ open: "[", close: "]" },
	{ open: "(", close: ")" },
	{ open: "{", close: "}" },
];

// The markup delimiters, which are only delimiters where Spruce parses them as
// such. Auto-closing them unconditionally is what makes a typed `$` come out as
// `$$` inside a raw function argument, a declaration block or a code block —
// there `$` is just a dollar sign, `*` is multiplication, `_` is an identifier
// character and a backtick is the code fence you're trying to close.
const MARKUP_PAIRS = [
	{ open: "`", close: "`" },
	{ open: "$", close: "$" },
	{ open: "*", close: "*" },
	{ open: "_", close: "_" },
];

// A declaration block's body is JavaScript, where a backtick does open a pair.
const DECLARATION_PAIRS = [{ open: "`", close: "`" }];

function autoClosingPairsFor(context) {
	if (context === MARKUP) return [...BRACKET_PAIRS, ...MARKUP_PAIRS];
	if (context === DECLARATION) return [...BRACKET_PAIRS, ...DECLARATION_PAIRS];
	return BRACKET_PAIRS;
}

// The context the pairs currently registered were computed for, so a cursor move
// within the same construct costs nothing.
let pairContext;
let pairRegistration;

// Swap the language's auto-closing pairs to the set that suits `context`.
// setLanguageConfiguration registers at a higher priority than the contributed
// language-configuration.json and the editor resolves the two field by field, so
// naming only autoClosingPairs here leaves that file's brackets, surrounding
// pairs and folding markers in force. (surroundingPairs can't be swapped this
// way — the API drops it — but those only apply to an explicit wrap of a
// selection, not to a keystroke that emits a character on its own.)
function applyAutoClosingPairs(context) {
	if (context === pairContext) return;
	pairContext = context;

	if (pairRegistration) pairRegistration.dispose();
	pairRegistration = vscode.languages.setLanguageConfiguration("spruce", {
		autoClosingPairs: autoClosingPairsFor(context),
	});
}

// Recompute the pairs for wherever the caret now sits. Synchronous on purpose:
// the answer has to be in place before the *next* keystroke, and a round trip to
// the language server would land after it (see server/context.mjs).
function refreshAutoClosingPairs(editor) {
	if (!editor || editor.document.languageId !== "spruce") return;
	const offset = editor.document.offsetAt(editor.selection.active);
	applyAutoClosingPairs(contextAt(editor.document.getText(), offset));
}

function activate(context) {
	const serverModule = context.asAbsolutePath(path.join("dist", "server.mjs"));

	const serverOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ["--nolazy", "--inspect=6009"] },
		},
	};

	const clientOptions = {
		documentSelector: [{ scheme: "file", language: "spruce" }],
	};

	client = new LanguageClient("spruce", "Spruce Language Server", serverOptions, clientOptions);
	client.start();

	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection((event) => {
			if (event.textEditor === vscode.window.activeTextEditor) refreshAutoClosingPairs(event.textEditor);
		}),
		vscode.window.onDidChangeActiveTextEditor(refreshAutoClosingPairs),
		// An edit that leaves the caret where it is (an undo, a change from
		// another editor on the same document) can still change the context.
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.activeTextEditor;
			if (editor && event.document === editor.document) refreshAutoClosingPairs(editor);
		}),
		{ dispose: () => pairRegistration && pairRegistration.dispose() },
	);

	refreshAutoClosingPairs(vscode.window.activeTextEditor);
}

function deactivate() {
	return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
