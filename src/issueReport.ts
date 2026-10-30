/**
 * Pure text for "MCP Server: Browser: Report Issue".
 *
 * The command never uploads this itself. It opens a GitHub new-issue URL
 * with the diagnostics field filled in; GitHub receives it only if the user
 * submits. Keep this file free of vscode and http so the redaction rules
 * stay unit-tested.
 *
 * `BUG_REPORT_URL` must match `bugs.url` in package.json.
 *
 * The lines `buildDiagnostics` emits are the field list in README and PRIVACY.md.
 * A field collected here and missing there, or listed there and not emitted, is a bug.
 */

export const REPO_WEB = "https://github.com/Nuanst-GmbH/mcp-server-browser";
export const BUG_REPORT_TEMPLATE = "bug_report.yml";
export const BUG_REPORT_URL = `${REPO_WEB}/issues/new?template=${BUG_REPORT_TEMPLATE}`;

/** Stay under common browser / GitHub URL limits after encoding. */
export const MAX_ISSUE_URL_CHARS = 7500;

export interface IssueReportInput {
  extensionVersion: string;
  vscodeVersion: string;
  appName: string;
  /** 'desktop' or 'web' */
  uiKind: string;
  /** vscode.env.remoteName (`wsl`, `ssh-remote`, …) or '' when local */
  remoteName: string;
  platform: string;
  arch: string;
  /** `browserTool.browserTab` */
  browserTab: boolean;
  /** Proposed `vscode.window.openBrowserTab` is present in this window. */
  browserApi: boolean;
}

/** Drop credentials and fragments from a URL. Invalid URLs lose `user:pass@` only. */
export function redactUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    u.username = "";
    u.password = "";
    u.hash = "";
    let out = u.toString();
    if (!trimmed.endsWith("/") && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return trimmed.replace(/(\/\/)[^/@\s]+@/, "$1");
  }
}

/**
 * Path only. Query strings are dropped because they can carry tokens.
 * The caller still runs {@link redactSecrets} on the finished report.
 */
export function redactPath(path: string): string {
  const q = path.indexOf("?");
  if (q === -1) return path;
  return `${path.slice(0, q)}?[query redacted]`;
}

const URL_IN_TEXT = /https?:\/\/[^\s)]+/g;

/** Redact every http(s) URL embedded in a collected string. */
export function redactEmbeddedUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (raw) => redactPath(redactUrl(raw)));
}

/** Bearer tokens, `sk-…` keys, and `api_key=` / `authorization=` assignments. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|authorization)\s*[:=]\s*["']?)[^\s"']+/gi, "$1[redacted]");
}

function sanitize(value: string): string {
  return redactSecrets(redactEmbeddedUrls(value));
}

/**
 * Diagnostics block placed in the GitHub issue form.
 * Does not contain page URLs, cookies, typed text, or workspace paths.
 */
export function buildDiagnostics(input: IssueReportInput): string {
  const remote = input.remoteName.trim() ? sanitize(input.remoteName.trim()) : "local";
  const lines = [
    "MCP Server: Browser diagnostics",
    `extension: ${sanitize(input.extensionVersion)}`,
    `vscode: ${sanitize(input.vscodeVersion)} (${sanitize(input.appName)}, ${sanitize(input.uiKind)})`,
    `os: ${sanitize(input.platform)} ${sanitize(input.arch)}`,
    `remote: ${remote}`,
    `browser tab setting: ${input.browserTab ? "on" : "off"}`,
    `integrated browser API: ${input.browserApi ? "available" : "unavailable"}`,
  ];
  return redactSecrets(lines.join("\n"));
}

function withDiagnostics(templateUrl: string, diagnostics: string): string {
  const u = new URL(templateUrl);
  u.searchParams.set("diagnostics", diagnostics);
  return u.toString();
}

/**
 * New-issue URL for `templateUrl` (normally {@link BUG_REPORT_URL}) with the
 * diagnostics field set. Shrinks the field until the URL fits {@link MAX_ISSUE_URL_CHARS}.
 */
export function reportIssueUrl(templateUrl: string, diagnostics: string): string {
  const note = "\n[truncated to fit the issue link]";
  let body = diagnostics;
  let url = withDiagnostics(templateUrl, body);
  let guard = 0;
  while (url.length > MAX_ISSUE_URL_CHARS && body.length > note.length && guard < 20) {
    guard++;
    const over = url.length - MAX_ISSUE_URL_CHARS;
    const nextLen = Math.max(0, body.length - Math.max(over, 64) - note.length);
    body = diagnostics.slice(0, nextLen) + note;
    url = withDiagnostics(templateUrl, body);
  }
  return url;
}
