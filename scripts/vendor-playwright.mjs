/**
 * Copy the Playwright packages next to the extension so the MCP server can
 * require them after the VSIX excludes node_modules. Browsers stay in the
 * Playwright cache; this copies the driver packages only.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "vendor");

function copyPkg(name) {
  const from = path.join(root, "node_modules", name);
  if (!existsSync(from)) {
    console.error(`missing ${from}. Run npm ci before compile.`);
    process.exit(1);
  }
  cpSync(from, path.join(dest, name), {
    recursive: true,
    filter: (src) => path.basename(src) !== "node_modules",
  });
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyPkg("playwright");
copyPkg("playwright-core");
console.log(`vendored playwright into ${dest}`);
