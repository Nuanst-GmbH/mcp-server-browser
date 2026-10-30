import * as esbuild from "esbuild";

// Two CJS bundles. `playwright` stays external (the compile step copies it
// into vendor/, and the server banner resolves it from there). `vscode` is
// provided by the extension host. node_modules is not shipped in the VSIX.
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
};

await esbuild.build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});

await esbuild.build({
  ...shared,
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  external: ["playwright", "vscode"],
  // Runs before the bundle's require("playwright"). Only the MCP server
  // process loads this file, so the resolver does not patch the extension host.
  banner: {
    js: `
const __pwModule = require("module");
const __pwPath = require("path");
const __pwVendor = __pwPath.join(__dirname, "..", "vendor");
const __pwResolve = __pwModule._resolveFilename;
__pwModule._resolveFilename = function (request, parent, isMain, options) {
  if (request === "playwright") request = __pwPath.join(__pwVendor, "playwright");
  else if (request === "playwright-core") request = __pwPath.join(__pwVendor, "playwright-core");
  return __pwResolve.call(this, request, parent, isMain, options);
};
`.trim(),
  },
});
