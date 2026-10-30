# Next steps

Work that is intentionally not in the current tree. Multi-window VS Code is already handled. Multi-agent use in one window is not.

## Later: give each agent its own browser session

Two agents in the same VS Code window that both use this MCP server act on one page. That is the gap to close. The shape of the fix is not decided, so this is not ready to implement.

### How it works today

- VS Code starts one `browser-tool` server process per window (`contributes.mcp` in `package.json`).
- Each window has its own pipe, `vscode-browser-tool-<extension-host pid>`. The server finds that host by walking parent processes up to `Code.exe` (`src/bridge.ts`). A second window gets its own integrated tab and its own headless Chromium, and it does not attach to another window's tab.
- Inside one window there is one Playwright page for the life of the server (`src/browser.ts`) and one integrated browser tab (`TabBridge` in `src/extension.ts`).
- Tool calls carry no agent id. Nothing queues or locks them. `close` tears down the headless browser for every client of that process.

Agents in different windows are already isolated. Agents in one window are not.

### Decisions still open

- Whether each agent gets its own page and tab, or they share one page behind a lock.
- How a call is tied to an agent. The MCP tool arguments do not include one today.
- What `close` means when more than one agent is connected.
- How the integrated tab behaves, given the extension keeps a single `ourTab`.

### Related code

- `src/server.ts` — tool handlers and engine choice (integrated tab, else headless twin).
- `src/browser.ts` — the single headless context.
- `src/extension.ts` — the single integrated tab.
- `src/bridge.ts` — per-window pipe. Leave this in place; multi-window isolation is not the task.
