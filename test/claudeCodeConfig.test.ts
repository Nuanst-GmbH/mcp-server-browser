/**
 * Edits to Claude Code's user MCP config (~/.claude.json).
 */
import assert from "node:assert/strict";
import { editClaudeUserConfig, nodeMajor, type StdioServerEntry } from "../src/claudeCodeConfig";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    const message = e instanceof Error ? e.message : String(e);
    failures.push(`${name}\n    ${message}`);
  }
}

function entry(script: string): StdioServerEntry {
  return { command: "node", args: [script] };
}

const installed = "C:/Users/me/.vscode/extensions/nuanst-gmbh.mcp-server-browser-0.4.0/dist/server.js";

test("adds browser-tool when the config file is missing", () => {
  const result = editClaudeUserConfig(undefined, entry(installed));
  assert.deepEqual(result, {
    status: "added",
    config: {
      mcpServers: {
        "browser-tool": { command: "node", args: [installed] },
      },
    },
  });
});

test("keeps other servers and top-level keys when adding browser-tool", () => {
  const result = editClaudeUserConfig(
    { userID: "abc", mcpServers: { github: { command: "npx", args: ["-y", "github"] } } },
    entry(installed),
  );
  assert.equal(result.status, "added");
  if (result.status !== "added") return;
  assert.equal(result.config.userID, "abc");
  assert.deepEqual(result.config.mcpServers, {
    github: { command: "npx", args: ["-y", "github"] },
    "browser-tool": { command: "node", args: [installed] },
  });
});

test("returns unchanged when the installed script path already matches", () => {
  const result = editClaudeUserConfig(
    {
      mcpServers: {
        "browser-tool": {
          command: "node",
          args: ["C:\\Users\\me\\.vscode\\extensions\\nuanst-gmbh.mcp-server-browser-0.4.0\\dist\\server.js"],
        },
      },
    },
    entry(installed),
  );
  assert.deepEqual(result, { status: "unchanged" });
});

test("updates the script path and keeps env when the extension folder changes", () => {
  const updated = "C:/Users/me/.vscode/extensions/nuanst-gmbh.mcp-server-browser-0.5.0/dist/server.js";
  const result = editClaudeUserConfig(
    {
      mcpServers: {
        "browser-tool": {
          command: "node",
          args: [installed],
          env: { BROWSER_TOOL_CHANNEL: "chrome" },
        },
      },
    },
    entry(updated),
  );
  assert.deepEqual(result, {
    status: "refreshed",
    config: {
      mcpServers: {
        "browser-tool": {
          command: "node",
          args: [updated],
          env: { BROWSER_TOOL_CHANNEL: "chrome" },
        },
      },
    },
  });
});

test("returns conflict when browser-tool points at a different program", () => {
  const result = editClaudeUserConfig(
    { mcpServers: { "browser-tool": { command: "npx", args: ["-y", "@playwright/mcp"] } } },
    entry(installed),
  );
  assert.deepEqual(result, { status: "conflict" });
});

test("returns invalid when the config root is an array", () => {
  assert.deepEqual(editClaudeUserConfig([], entry(installed)), { status: "invalid" });
});

test("returns invalid when mcpServers is not an object", () => {
  assert.deepEqual(editClaudeUserConfig({ mcpServers: ["browser-tool"] }, entry(installed)), { status: "invalid" });
});

test("reads the major version from node -v output", () => {
  assert.equal(nodeMajor("v20.11.1\n"), 20);
  assert.equal(nodeMajor("v18.0.0"), 18);
  assert.equal(nodeMajor("not-a-version"), undefined);
});

if (failed > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
