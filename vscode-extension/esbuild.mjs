// Bundles the extension's client and server into single files under dist/ so the
// published .vsix ships a handful of files instead of the whole node_modules tree
// (json5, ohm-js, vscode-languageserver*, and their transitive deps get inlined).
//
// Run via build-and-install.sh, which first vendors spruce.js/stdlib.js into
// server/ so esbuild can resolve those imports.
import * as esbuild from "esbuild";
import { cpSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = dirname(fileURLToPath(import.meta.url));

// spruce.js is dual-purpose: a library (grammarFor/compile, which the server
// imports) plus a CLI tail guarded by `import.meta.url === argv[1]` with top-level
// await. Bundled into the server entry, that guard would match when VS Code forks
// the server and the CLI would hijack startup — so strip the tail at build time.
// The server only needs the exports above it. Throw if the marker moves so a
// future spruce.js edit fails the build loudly instead of shipping a broken server.
const stripSpruceCli = {
	name: "strip-spruce-cli",
	setup(build) {
		build.onLoad({ filter: /[\\/]spruce\.js$/ }, (args) => {
			const src = readFileSync(args.path, "utf8");
			const marker = "if (process.argv[1] && import.meta.url === pathToFileURL";
			const idx = src.indexOf(marker);
			if (idx === -1) {
				throw new Error(
					`strip-spruce-cli: CLI entry guard not found in ${args.path}; update the marker in esbuild.mjs.`
				);
			}
			return { contents: src.slice(0, idx), loader: "js" };
		});
	},
};

const shared = {
	bundle: true,
	platform: "node",
	target: "node20",
	// "vscode" is provided by the host at runtime and must never be bundled.
	external: ["vscode"],
	minify: true,
	logLevel: "info",
};

// The extension host loads the client's main as CommonJS. It pulls in
// server/context.mjs (the caret-context scan behind the dynamic auto-closing
// pairs), which esbuild converts along the way — that module deliberately
// imports nothing, so ohm and spruce.js stay out of this bundle.
await esbuild.build({
	...shared,
	entryPoints: [join(root, "client/extension.js")],
	outfile: join(root, "dist/extension.js"),
	format: "cjs",
});

// The server is forked as its own node process; emit ESM (.mjs) so import.meta.url
// resolves natively (completion.mjs reads stdlib.js relative to it). The bundled
// CommonJS deps (vscode-jsonrpc et al.) call require() at runtime, which esbuild's
// ESM output stubs out with a throwing shim — so restore a real require via the
// banner, otherwise loading throws "Dynamic require of 'node:util' is not supported".
await esbuild.build({
	...shared,
	entryPoints: [join(root, "server/server.mjs")],
	outfile: join(root, "dist/server.mjs"),
	format: "esm",
	banner: {
		js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
	},
	plugins: [stripSpruceCli],
});

// completion.mjs reads stdlib.js's raw source at runtime (go-to-definition into
// the stdlib) via new URL("./stdlib.js", import.meta.url) — a file read, not an
// import — so it must sit next to the bundled server. Copy the un-minified source
// so the definition's line/column lookups stay accurate.
cpSync(join(root, "server/stdlib.js"), join(root, "dist/stdlib.js"));
