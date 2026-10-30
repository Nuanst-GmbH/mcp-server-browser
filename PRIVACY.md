# Privacy

MCP Server: Browser does not phone home. It does not send telemetry to Nuanst or to GitHub on its own.

The MCP server talks to VS Code over stdio on this machine. When the browser-tab setting is on, the extension host and that server also talk over a local named pipe. Pages an agent opens make their own requests to those sites. Cookies copied from VS Code's integrated browser into the headless browser stay in that local browser. They are not sent to Nuanst.

## Report Issue

**MCP Server: Browser: Report Issue** builds a text draft and opens a GitHub new-issue page with that draft in the Diagnostics field:

<https://github.com/Nuanst-GmbH/mcp-server-browser/issues/new?template=bug_report.yml>

The command opens that browser URL. It does not upload the draft. Nothing in the draft is sent until you submit the issue. The page is a normal GitHub form: edit or delete the text first. The form asks you to confirm you reviewed it. The command can also copy the draft to the clipboard instead of opening GitHub.

The draft includes:

- This extension's version
- VS Code version and product name, and whether the window is desktop or web
- Operating system platform and CPU architecture (`win32`, `darwin`, or `linux`, and `x64` or `arm64`). Not a username, home directory, or hostname
- Remote window type: `local` when the window is not remote, otherwise the kind of remote (`wsl`, `ssh-remote`, and similar). Not a hostname
- The `browserTool.browserTab` setting, on or off
- Whether this window has the proposed integrated browser API (`openBrowserTab`): available or unavailable

The draft does not include:

- Page URLs, cookies, page text, screenshots, or text typed into a page
- API keys, bearer tokens, or `sk-` secrets. If one of those strings appears in a collected field, it is replaced with `[redacted]`
- Usernames, passwords, and fragments in a URL. A query string is replaced with `[query redacted]`
- File contents, workspace paths, usernames, or machine hostnames

The command does not run a network probe and does not send a test prompt. If the draft is too long for a browser URL, the command shortens it and adds a line saying it was truncated.
