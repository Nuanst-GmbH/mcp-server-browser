/**
 * Smoke tests for src/issueReport.ts — redaction and the GitHub issue URL.
 * Bundled by test/run.mjs (esbuild) and executed in plain Node.
 */
import assert from "node:assert/strict";
import {
  BUG_REPORT_URL,
  MAX_ISSUE_URL_CHARS,
  buildDiagnostics,
  redactPath,
  redactSecrets,
  redactUrl,
  reportIssueUrl,
  type IssueReportInput,
} from "../src/issueReport";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}\n    ${(e as Error).message}`);
  }
}

function fixture(over: Partial<IssueReportInput> = {}): IssueReportInput {
  return {
    extensionVersion: "0.4.0",
    vscodeVersion: "1.104.0",
    appName: "Visual Studio Code",
    uiKind: "desktop",
    remoteName: "",
    platform: "win32",
    arch: "x64",
    browserTab: false,
    browserApi: false,
    ...over,
  };
}

test("redactUrl drops username, password, and fragment", () => {
  assert.equal(
    redactUrl("https://user:s3cret-key@proxy.internal:4000/v1#token"),
    "https://proxy.internal:4000/v1",
  );
});

test("redactUrl keeps a credential-free URL without adding a trailing slash", () => {
  assert.equal(redactUrl("http://localhost:4000"), "http://localhost:4000");
});

test("redactUrl strips userinfo from a string that is not a URL", () => {
  assert.equal(redactUrl("http://user:s3cret-key@not a url"), "http://not a url");
});

test("redactPath replaces the query string", () => {
  assert.equal(redactPath("/search?token=abcdef"), "/search?[query redacted]");
  assert.equal(redactPath("/models"), "/models");
});

test("redactSecrets replaces bearer tokens, sk- keys, and api_key assignments", () => {
  assert.equal(
    redactSecrets("upstream bearer sk-liveABCDEFGHIJ and api_key=s3cret-key"),
    "upstream bearer [redacted] and api_key=[redacted]",
  );
});

test("buildDiagnostics lists only the browser-tool facts", () => {
  const text = buildDiagnostics(fixture({ browserTab: true, browserApi: true }));
  assert.deepEqual(text.split("\n"), [
    "MCP Server: Browser diagnostics",
    "extension: 0.4.0",
    "vscode: 1.104.0 (Visual Studio Code, desktop)",
    "os: win32 x64",
    "remote: local",
    "browser tab setting: on",
    "integrated browser API: available",
  ]);
});

test("buildDiagnostics names the remote window type when one is set", () => {
  const text = buildDiagnostics(fixture({ remoteName: "wsl" }));
  assert.ok(text.includes("remote: wsl"));
  assert.equal(text.includes("remote: local"), false);
});

test("buildDiagnostics removes credentials, query strings, and tokens from collected strings", () => {
  const text = buildDiagnostics(fixture({
    appName: "Code bearer sk-liveABCDEFGHIJ authorization=supersecret",
    remoteName: "https://user:s3cret-key@browser.internal/tab?token=abcdef#frag",
    extensionVersion: "0.4.0 sk-otherKEY12345678",
  }));
  assert.ok(text.includes("bearer [redacted]"));
  assert.ok(text.includes("authorization=[redacted]"));
  assert.ok(text.includes("extension: 0.4.0 [redacted]"));
  assert.ok(text.includes("remote: https://browser.internal/tab?[query redacted]"));
  assert.equal(text.includes("s3cret-key"), false);
  assert.equal(text.includes("user:s3cret-key"), false);
  assert.equal(text.includes("token=abcdef"), false);
  assert.equal(text.includes("#frag"), false);
  assert.equal(text.includes("sk-liveABCDEFGHIJ"), false);
  assert.equal(text.includes("sk-otherKEY12345678"), false);
  assert.equal(text.includes("supersecret"), false);
});

test("reportIssueUrl targets the bug-report form and the diagnostics field", () => {
  const url = reportIssueUrl(BUG_REPORT_URL, "extension: 0.4.0");
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://github.com/Nuanst-GmbH/mcp-server-browser/issues/new");
  assert.equal(parsed.searchParams.get("template"), "bug_report.yml");
  assert.equal(parsed.searchParams.get("diagnostics"), "extension: 0.4.0");
});

test("reportIssueUrl shortens diagnostics so the link stays within the URL cap", () => {
  const url = reportIssueUrl(BUG_REPORT_URL, "x".repeat(20_000));
  assert.ok(url.length <= MAX_ISSUE_URL_CHARS);
  const diagnostics = new URL(url).searchParams.get("diagnostics") ?? "";
  assert.ok(diagnostics.endsWith("[truncated to fit the issue link]"));
  assert.ok(diagnostics.length < 20_000);
});

if (failed > 0) {
  console.error(`issueReport: FAIL — ${failed} of ${passed + failed} groups failed:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`issueReport: ${passed} groups passed`);
