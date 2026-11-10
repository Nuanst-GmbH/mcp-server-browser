import * as vscode from "vscode";
import { execFile } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostPipePath } from "./bridge.js";
import {
  ClaudeConfigInvalid,
  editClaudeUserConfig,
  nodeMajor,
  readClaudeUserConfig,
  saveClaudeUserConfig,
  type StdioServerEntry,
} from "./claudeCodeConfig.js";
import { isDeadCdpSessionMessage } from "./cdpSession.js";
import { BUG_REPORT_URL, buildDiagnostics, reportIssueUrl } from "./issueReport.js";
import {
  DOCUMENT_COOKIE_EXPRESSION,
  cookiesFromDocument,
  isBrowserLevelMethod,
  pickPageTarget,
  readAttachedSessionId,
  readDocumentCookieDump,
  readEvaluateValue,
  readTargetInfos,
} from "./pageTarget.js";

// Extension host side of the browser-tab bridge.
//
// The MCP server (a plain Node child process) cannot call the vscode API, so
// when the user enables the `browserTool.browserTab` setting, this extension
// listens on the named pipe and opens/navigates VS Code's integrated browser
// tab on request.
//
// IMPORTANT — proposed API rules: reading `vscode.window.openBrowserTab` is
// harmless, but CALLING it or SUBSCRIBING to the tab events triggers VS Code's
// proposal check. On a stable VS Code build, the manifest's
// `enabledApiProposals` is honored only in extension-development mode; for a
// normally installed extension the user must start VS Code with
// `--enable-proposed-api Nuanst-GmbH.mcp-server-browser` (or the
// `enable-proposed-api` entry in argv.json). Therefore NOTHING proposed is
// touched unless the setting is on, and even then the whole start is wrapped
// so an unavailable proposal degrades to a warning + one-click fix instead of
// crashing activation.

const SETTING = "browserTool.browserTab";
const PROPOSAL_KEY = "enable-proposed-api";
const CLAUDE_OFFER_DISMISSED = "browserTool.claudeCodeOfferDismissed";
const MCP_PROVIDER_ID = "browser-tool";
const CDP_PING_TIMEOUT_MS = 1_000;
const CDP_RECOVERY_COOLDOWN_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCdpResponse(message: unknown): { id: number; error?: string; result: unknown } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  if (!("id" in message) || typeof message.id !== "number") return undefined;
  const result = "result" in message ? message.result : undefined;
  if (!("error" in message) || message.error == null) return { id: message.id, result };
  if (typeof message.error !== "object") return { id: message.id, result, error: "CDP command failed" };
  if (!("message" in message.error) || typeof message.error.message !== "string" || message.error.message === "") {
    return { id: message.id, result, error: "CDP command failed" };
  }
  return { id: message.id, result, error: message.error.message };
}

function cookieList(result: unknown): unknown[] {
  if (typeof result !== "object" || result === null) return [];
  if (!("cookies" in result) || !Array.isArray(result.cookies)) return [];
  return result.cookies;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type BrowserWindowApi = {
  browserTabs?: readonly vscode.BrowserTab[];
  activeBrowserTab?: vscode.BrowserTab;
  onDidOpenBrowserTab?: vscode.Event<vscode.BrowserTab>;
  onDidCloseBrowserTab?: vscode.Event<vscode.BrowserTab>;
  onDidChangeActiveBrowserTab?: vscode.Event<vscode.BrowserTab | undefined>;
};

function browserWindow(): BrowserWindowApi {
  return vscode.window as BrowserWindowApi;
}

type OpenTabFn = (url: string, options?: { preserveFocus?: boolean }) => Thenable<vscode.BrowserTab>;

// ---------------------------------------------------------------------------
// Proposal enablement (guided, via VS Code's own argv.json command)
// ---------------------------------------------------------------------------

// We deliberately do NOT locate or rewrite argv.json ourselves — path guessing
// and JSON surgery on a global config file is exactly the kind of thing an
// extension shouldn't do. Instead we use VS Code's built-in
// "Configure Runtime Arguments" command (which knows the right file for any
// build), then — read-only, from the document that command just opened — pick
// the right paste-ready snippet: the whole key if the list is absent, just
// the entry line if other extensions are already listed (so a naive paste can
// never create a duplicate key).
// Command id differs across VS Code builds ("Arguments" vs "Args"); try both.
const OPEN_ARGV_COMMANDS = [
  "workbench.action.configureRuntimeArguments",
  "workbench.action.configureRuntimeArgs",
] as const;

async function enableProposal(extId: string, out: vscode.OutputChannel): Promise<void> {
  let opened = false;
  for (const id of OPEN_ARGV_COMMANDS) {
    try {
      await vscode.commands.executeCommand(id);
      opened = true;
      break;
    } catch {
      /* try the next id */
    }
  }
  if (!opened) {
    out.appendLine("Could not open argv.json via command; asked the user to use the palette.");
  }

  // The document opens asynchronously; give it a moment.
  let doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith("argv.json"));
  for (let i = 0; i < 20 && !doc; i++) {
    await new Promise((r) => setTimeout(r, 100));
    doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith("argv.json"));
  }

  const text = doc?.getText() ?? "";
  let snippet: string;
  let message: string;
  if (text.includes(extId)) {
    snippet = "";
    message = `${extId} is already in ${PROPOSAL_KEY} — nothing to add, just fully restart VS Code.`;
  } else if (new RegExp(`"${PROPOSAL_KEY}"\\s*:`).test(text)) {
    // Other extensions already use the proposal: add our id inside their array.
    snippet = `    "${extId}",`;
    message =
      `argv.json already lists other extensions — add this line INSIDE the existing ` +
      `${PROPOSAL_KEY} array (on your clipboard), and fully restart VS Code:\n${snippet}`;
  } else {
    snippet = `"${PROPOSAL_KEY}": [\n    "${extId}"\n  ]`;
    message = `argv.json is open — merge this (already on your clipboard) and fully restart VS Code:\n${snippet}`;
  }

  if (snippet) {
    try {
      await vscode.env.clipboard.writeText(snippet);
    } catch {
      /* clipboard unavailable; the snippet is shown in the message too */
    }
  }
  if (!opened) {
    message =
      `Couldn't open argv.json automatically — open it from the command palette` +
      ` ("Preferences: Configure Runtime Arguments"), then follow the rest:\n${message}`;
  }
  out.appendLine(`${opened ? "Opened" : "Could not open"} argv.json for ${PROPOSAL_KEY} setup (${extId}).`);
  vscode.window.showInformationMessage(message);
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

class TabBridge {
  private ourTab: vscode.BrowserTab | undefined;
  private readonly openedTabs = new WeakSet<vscode.BrowserTab>();
  private cdp: vscode.BrowserCDPSession | undefined;
  private pageSessionId: string | undefined;
  private cdpReason = "no CDP session";
  private cdpSeq = 1;
  private attachGeneration = 0;
  private attaching: Promise<void> | undefined;
  private sessionListeners: vscode.Disposable | undefined;
  private server: net.Server | null = null;
  private tabOperation: Promise<void> = Promise.resolve();
  private recoveryFailedAt = 0;
  private lastStatusKey = "";

  constructor(
    private readonly out: vscode.OutputChannel,
    private readonly openTab: OpenTabFn,
    private readonly disposables: vscode.Disposable[],
  ) {
    // Subscribing triggers the proposal check — only called when the setting
    // is on, and inside activate()'s try/catch.
    const win = browserWindow();
    if (win.onDidCloseBrowserTab) {
      this.disposables.push(
        win.onDidCloseBrowserTab((tab) => {
          if (tab === this.ourTab) {
            this.ourTab = undefined;
            this.closeCdp();
          }
        }),
      );
    }
    // A tab the user opened themselves is otherwise invisible: ourTab used to
    // be set only for tabs this bridge opened.
    if (win.onDidOpenBrowserTab) {
      this.disposables.push(
        win.onDidOpenBrowserTab((tab) => {
          if (!this.ourTab) void this.follow(tab);
        }),
      );
    }
    if (win.onDidChangeActiveBrowserTab) {
      this.disposables.push(
        win.onDidChangeActiveBrowserTab((tab) => {
          if (tab) void this.follow(tab);
        }),
      );
    }
  }

  private closeCdp(): void {
    this.attachGeneration++;
    this.pageSessionId = undefined;
    this.sessionListeners?.dispose();
    this.sessionListeners = undefined;
    if (!this.cdp) return;
    const session = this.cdp;
    this.cdp = undefined;
    Promise.resolve(session.close()).catch(() => undefined);
  }

  private enqueueTabOperation(operation: () => Promise<void>): Promise<void> {
    const run = this.tabOperation.then(operation, operation);
    this.tabOperation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private currentTabUrl(): string | undefined {
    const tab = this.ourTab;
    if (!tab) return undefined;
    try {
      return tab.url || undefined;
    } catch {
      return undefined;
    }
  }

  private async closeOurTab(): Promise<void> {
    if (!this.ourTab) return;
    const old = this.ourTab;
    this.ourTab = undefined;
    // A tab the user opened stays open. Only tabs this bridge created are closed.
    if (!this.openedTabs.has(old)) return;
    await Promise.resolve(old.close()).catch(() => undefined);
  }

  private preferredOpenTab(): vscode.BrowserTab | undefined {
    const win = browserWindow();
    if (win.activeBrowserTab) return win.activeBrowserTab;
    const tabs = win.browserTabs;
    return tabs && tabs.length > 0 ? tabs[0] : undefined;
  }

  private ensureTab(): Promise<void> {
    if (this.ourTab) return Promise.resolve();
    const tab = this.preferredOpenTab();
    if (!tab) return Promise.resolve();
    return this.follow(tab);
  }

  private follow(tab: vscode.BrowserTab): Promise<void> {
    return this.enqueueTabOperation(() => this.useTab(tab));
  }

  private async useTab(tab: vscode.BrowserTab): Promise<void> {
    if (this.ourTab === tab && this.pageSessionId) return;
    const switched = this.ourTab !== tab;
    if (switched) this.closeCdp();
    this.ourTab = tab;
    if (switched) this.out.appendLine(`Using integrated browser tab: ${this.currentTabUrl() ?? "(no url)"}`);
    if (!this.cdp) await this.attachCdp(tab);
    else if (!this.pageSessionId) await this.attachPageTarget(tab);
  }

  private watchSession(session: vscode.BrowserCDPSession): void {
    this.sessionListeners?.dispose();
    const subscriptions = [
      session.onDidClose(() => {
        if (this.cdp !== session) return;
        this.cdp = undefined;
        this.pageSessionId = undefined;
        this.cdpReason = "CDP session closed";
      }),
      session.onDidReceiveMessage((msg) => {
        if (this.cdp !== session) return;
        if (typeof msg !== "object" || msg === null || !("method" in msg)) return;
        if ("id" in msg && typeof msg.id === "number") return;
        if (msg.method !== "Target.detachedFromTarget") return;
        const params = "params" in msg && typeof msg.params === "object" && msg.params !== null ? msg.params : undefined;
        const sessionId =
          params && "sessionId" in params && typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (!sessionId || sessionId !== this.pageSessionId) return;
        this.pageSessionId = undefined;
        this.cdpReason = "page session detached";
        this.out.appendLine("Page CDP session detached.");
      }),
    ];
    this.sessionListeners = vscode.Disposable.from(...subscriptions);
  }

  private async attachCdp(tab: vscode.BrowserTab): Promise<void> {
    if (typeof tab.startCDPSession !== "function") {
      this.cdpReason = "this VS Code build has no startCDPSession";
      return;
    }
    try {
      const session = await tab.startCDPSession();
      this.cdp = session;
      this.watchSession(session);
      this.out.appendLine("CDP session attached; attaching to the page target.");
      await this.attachPageTarget(tab);
    } catch (error) {
      this.closeCdp();
      this.cdpReason = `CDP session unavailable: ${errorMessage(error)}`;
      this.out.appendLine(`${this.cdpReason} (will reopen the tab on navigate)`);
    }
  }

  private attachPageTarget(tab: vscode.BrowserTab): Promise<void> {
    if (this.pageSessionId) return Promise.resolve();
    if (this.attaching) return this.attaching;
    const generation = this.attachGeneration;
    this.attaching = this.attachPageTargetOnce(tab, generation).finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }

  // The extension CDP session is the browser proxy. Page methods are
  // "Method not found" until Target.attachToTarget returns a sessionId and
  // later commands include it.
  private async attachPageTargetOnce(tab: vscode.BrowserTab, generation: number): Promise<void> {
    let lastError = "Target.getTargets returned no page";
    for (let attempt = 0; attempt < 5; attempt++) {
      if (generation !== this.attachGeneration) return;
      try {
        const listed = await this.sendCdp("Target.getTargets", {}, 5_000);
        if (generation !== this.attachGeneration) return;
        const page = pickPageTarget(readTargetInfos(listed), this.currentTabUrl() ?? tab.url);
        if (!page) {
          lastError = "Target.getTargets returned no page";
          await delay(150);
          continue;
        }
        const attached = await this.sendCdp(
          "Target.attachToTarget",
          { targetId: page.targetId, flatten: true },
          5_000,
        );
        if (generation !== this.attachGeneration) return;
        const sessionId = readAttachedSessionId(attached);
        if (!sessionId) {
          lastError = "Target.attachToTarget returned no sessionId";
          await delay(150);
          continue;
        }
        this.pageSessionId = sessionId;
        this.cdpReason = "page session attached";
        this.out.appendLine(`Attached to page target ${page.targetId}${page.url ? ` (${page.url})` : ""}.`);
        return;
      } catch (error) {
        lastError = errorMessage(error);
        await delay(150);
      }
    }
    if (generation !== this.attachGeneration) return;
    this.pageSessionId = undefined;
    this.cdpReason = `page target not attached: ${lastError}`;
    this.out.appendLine(this.cdpReason);
  }

  private async replaceTab(url: string): Promise<void> {
    this.closeCdp();
    await this.closeOurTab();
    const tab = await this.openTab(url, { preserveFocus: true });
    this.openedTabs.add(tab);
    this.ourTab = tab;
    this.out.appendLine(`Opened browser tab: ${tab.url}`);
    await this.attachCdp(tab);
  }

  // One tab at a time. Prefer steering the existing tab via CDP (Page.navigate)
  // so the user's view doesn't flicker; fall back to close + reopen.
  // sendMessage() resolves when the message is sent, not when the target
  // answers, so navigate goes through sendCdp and a dead target is observable.
  async handle(url: string): Promise<void> {
    await this.enqueueTabOperation(() => this.navigateOrReplace(url));
  }

  private async navigateOrReplace(url: string): Promise<void> {
    if (!this.ourTab) {
      const existing = this.preferredOpenTab();
      if (existing) await this.useTab(existing);
    }
    if (this.ourTab) {
      if (!this.cdp) await this.attachCdp(this.ourTab);
      if (this.cdp) {
        try {
          if (!this.pageSessionId) await this.attachPageTarget(this.ourTab);
          await this.sendCdp("Page.navigate", { url }, 15_000);
          return;
        } catch (error) {
          this.out.appendLine(`Page.navigate failed (${errorMessage(error)}); reopening the tab.`);
          this.closeCdp();
        }
      }
    }
    await this.replaceTab(url);
  }

  private async reopenIfStillDead(): Promise<void> {
    if (await this.pingCdp()) return;
    const url = this.currentTabUrl();
    if (!url) {
      this.closeCdp();
      return;
    }
    this.out.appendLine(`CDP session is not responding; reopening ${url}.`);
    this.closeCdp();
    await this.replaceTab(url);
  }

  // True only when the page target answers a command. A dead page target is
  // reopened once; a session that never attached to a page is not reopened,
  // because reopening does not fix "Method not found" from the browser proxy.
  // Repeated failures back off so a broken tab is not reopened on every call.
  private async cdpIsLive(): Promise<boolean> {
    if (!this.ourTab) {
      this.cdpReason = "no integrated tab is open";
      return false;
    }
    if (!this.cdp) await this.attachCdp(this.ourTab);
    if (!this.cdp) return false;
    if (!this.pageSessionId) await this.attachPageTarget(this.ourTab);
    if (!this.pageSessionId) return false;
    if (await this.pingCdp()) {
      this.cdpReason = "page session answers Runtime.evaluate";
      return true;
    }
    this.cdpReason = "page session did not answer Runtime.evaluate";
    if (!this.currentTabUrl()) {
      this.closeCdp();
      return false;
    }
    if (Date.now() - this.recoveryFailedAt < CDP_RECOVERY_COOLDOWN_MS) return false;
    try {
      await this.enqueueTabOperation(() => this.reopenIfStillDead());
    } catch (error) {
      this.out.appendLine(`CDP recovery failed: ${errorMessage(error)}`);
      this.recoveryFailedAt = Date.now();
      this.cdpReason = `CDP recovery failed: ${errorMessage(error)}`;
      return false;
    }
    const alive = await this.pingCdp();
    this.recoveryFailedAt = alive ? 0 : Date.now();
    this.cdpReason = alive
      ? "page session answers Runtime.evaluate"
      : "page session did not answer after reopening the tab";
    return alive;
  }

  private pingCdp(): Promise<boolean> {
    if (!this.cdp || !this.pageSessionId) return Promise.resolve(false);
    return this.sendCdp("Runtime.evaluate", { expression: "1", returnByValue: true }, CDP_PING_TIMEOUT_MS).then(
      () => true,
      () => false,
    );
  }

  // Correlate a CDP command with its async response. sendMessage() resolves
  // when the message is *sent*, not answered — the result arrives on
  // onDidReceiveMessage, so we subscribe first, then send, then wait for the
  // message whose `id` matches. Non-matching messages (CDP events, other
  // commands' responses) are ignored.
  private sendCdp(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const session = this.cdp;
    if (!session) return Promise.reject(new Error("no CDP session attached to the integrated tab"));
    const pageSessionId = isBrowserLevelMethod(method) ? undefined : this.pageSessionId;
    if (!pageSessionId && !isBrowserLevelMethod(method)) {
      return Promise.reject(new Error("no page target attached on the integrated tab"));
    }
    const id = this.cdpSeq++;
    const message: { id: number; method: string; params: Record<string, unknown>; sessionId?: string } = {
      id,
      method,
      params,
    };
    if (pageSessionId) message.sessionId = pageSessionId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        dispose.dispose();
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const dispose = session.onDidReceiveMessage((msg) => {
        const reply = readCdpResponse(msg);
        if (!reply || reply.id !== id) return;
        if (reply.error) finish(new Error(reply.error));
        else finish(undefined, reply.result);
      });
      const timer = setTimeout(() => {
        finish(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      Promise.resolve(session.sendMessage(message)).catch((error: unknown) => {
        finish(new Error(`CDP session send failed: ${errorMessage(error)}`));
      });
    });
  }

  private async cdpRequest(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    if (!isBrowserLevelMethod(method)) {
      if (!this.ourTab) throw new Error("no integrated browser tab is open");
      if (!this.cdp) await this.attachCdp(this.ourTab);
      if (!this.cdp) throw new Error(this.cdpReason);
      if (!this.pageSessionId) await this.attachPageTarget(this.ourTab);
    }
    try {
      return await this.sendCdp(method, params, timeoutMs);
    } catch (error) {
      const message = errorMessage(error);
      if (this.ourTab && /session not found/i.test(message)) {
        this.pageSessionId = undefined;
        await this.attachPageTarget(this.ourTab);
        return this.sendCdp(method, params, timeoutMs);
      }
      if (!isDeadCdpSessionMessage(message, method)) throw error;
      try {
        await this.enqueueTabOperation(() => this.reopenIfStillDead());
      } catch (recoveryError) {
        this.out.appendLine(`CDP recovery failed: ${errorMessage(recoveryError)}`);
        throw error;
      }
      if (!this.cdp || (!isBrowserLevelMethod(method) && !this.pageSessionId)) throw error;
      return this.sendCdp(method, params, timeoutMs);
    }
  }

  // Network.getCookies on the page session includes HttpOnly SSO cookies.
  // Storage.getCookies is the older CDP shape. document.cookie is the last
  // resort and cannot see HttpOnly cookies, so that path is reported as such.
  private async fetchCookies(): Promise<{ cookies: unknown[]; source: "network" | "storage" | "document" }> {
    if (!this.ourTab) throw new Error("no integrated browser tab is open");
    if (!this.cdp) await this.attachCdp(this.ourTab);
    if (!this.cdp) throw new Error(this.cdpReason);
    const url = this.currentTabUrl();
    const networkParams = url && /^https?:/i.test(url) ? { urls: [url] } : {};
    try {
      await this.cdpRequest("Network.enable", {}, 2_000);
    } catch {
      /* getCookies is still attempted; some builds answer it without enable */
    }
    try {
      return { cookies: cookieList(await this.cdpRequest("Network.getCookies", networkParams)), source: "network" };
    } catch (error) {
      this.out.appendLine(`Network.getCookies failed (${errorMessage(error)}); trying Storage.getCookies`);
    }
    let lastError = "Network.getCookies failed";
    try {
      return { cookies: cookieList(await this.cdpRequest("Storage.getCookies")), source: "storage" };
    } catch (error) {
      lastError = errorMessage(error);
      this.out.appendLine(`Storage.getCookies failed (${lastError}); trying document.cookie`);
    }
    const evaluated = await this.cdpRequest("Runtime.evaluate", {
      expression: DOCUMENT_COOKIE_EXPRESSION,
      returnByValue: true,
    });
    const dump = readDocumentCookieDump(readEvaluateValue(evaluated));
    if (!dump) {
      throw new Error(
        `cookie export is unsupported on this integrated browser (${lastError}), and document.cookie could not be read`,
      );
    }
    const cookies = cookiesFromDocument(dump);
    if (cookies.length === 0) {
      throw new Error(
        `cookie export is unsupported on this integrated browser (${lastError}). document.cookie is empty, so HttpOnly session cookies were not copied`,
      );
    }
    this.out.appendLine("Copied document.cookie only; HttpOnly cookies are not visible to page script.");
    return { cookies, source: "document" };
  }

  private logStatus(present: boolean, cdp: boolean, reason: string): void {
    const key = `${present}|${cdp}|${reason}|${this.currentTabUrl() ?? ""}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.out.appendLine(`Tab status: present=${present} cdp=${cdp} (${reason})`);
  }

  start(): void {
    if (this.server) return;
    // This window's extension host serves this window's MCP server (which finds
    // us by walking up to this PID), so the pipe is named per our own PID —
    // one per window, no cross-window EADDRINUSE.
    const p = hostPipePath(process.pid);
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(p); // stale socket from a crashed VS Code
      } catch {
        /* absent */
      }
    }
    this.server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: { url?: unknown; action?: unknown; method?: unknown; params?: unknown };
        try {
          req = JSON.parse(line);
        } catch {
          this.reply(sock, false, "invalid JSON");
          return;
        }
        if (req.action === "status") {
          void this.ensureTab()
            .then(() => this.cdpIsLive())
            .then((cdp) => {
              const present = !!this.ourTab;
              const reason = present ? this.cdpReason : "no integrated tab is open";
              this.logStatus(present, cdp, reason);
              this.replyRaw(sock, {
                ok: true,
                present,
                cdp,
                url: this.currentTabUrl(),
                reason,
              });
            })
            .catch((error: unknown) => this.replyRaw(sock, { ok: false, error: errorMessage(error) }));
          return;
        }
        if (req.action === "cdp") {
          const method = typeof req.method === "string" ? req.method : "";
          if (!method) {
            this.replyRaw(sock, { ok: false, error: "cdp action missing method" });
            return;
          }
          const params =
            req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
          // Generous timeout: screenshots and heavy evaluates can take a while.
          void this.ensureTab()
            .then(() => this.cdpRequest(method, params, 30_000))
            .then((result) => this.replyRaw(sock, { ok: true, result }))
            .catch((e) => this.replyRaw(sock, { ok: false, error: e instanceof Error ? e.message : String(e) }));
          return;
        }
        if (req.action === "getCookies") {
          void this.ensureTab()
            .then(() => this.fetchCookies())
            .then(({ cookies, source }) => this.replyRaw(sock, { ok: true, cookies, source }))
            .catch((e) => this.replyRaw(sock, { ok: false, error: e instanceof Error ? e.message : String(e) }));
          return;
        }
        if (typeof req.url !== "string" || !req.url) {
          this.reply(sock, false, "missing url");
          return;
        }
        this.handle(req.url)
          .then(() => this.reply(sock, true))
          .catch((e) => this.reply(sock, false, e instanceof Error ? e.message : String(e)));
      });
      sock.on("error", () => undefined);
    });
    this.server.on("error", (e) => {
      this.out.appendLine(`Bridge listen error: ${e.message}`);
      this.server = null;
    });
    this.server.listen(p, () => {
      this.out.appendLine(`Browser-tab bridge listening on ${p}`);
      void this.ensureTab();
    });
  }

  private reply(sock: net.Socket, ok: boolean, error?: string): void {
    this.replyRaw(sock, ok ? { ok } : { ok, error });
  }

  private replyRaw(sock: net.Socket, obj: unknown): void {
    try {
      sock.end(JSON.stringify(obj) + "\n");
    } catch {
      /* client gone */
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.closeCdp();
    if (this.ourTab) {
      const old = this.ourTab;
      this.ourTab = undefined;
      if (this.openedTabs.has(old)) Promise.resolve(old.close()).catch(() => undefined);
    }
    this.out.appendLine("Browser-tab bridge stopped.");
  }
}

function extensionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserToolEntry(extensionPath: string): StdioServerEntry {
  return { command: "node", args: [path.join(extensionPath, "dist", "server.js")] };
}

function installedNodeMajor(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("node", ["-v"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) resolve(undefined);
      else resolve(nodeMajor(stdout));
    });
  });
}

async function addBrowserToolToClaudeCode(extensionPath: string): Promise<string> {
  const major = await installedNodeMajor();
  if (major === undefined || major < 20) {
    return "Node.js 20 or newer must be on PATH before Claude Code can start browser-tool.";
  }
  const home = os.homedir();
  let current: unknown;
  try {
    current = await readClaudeUserConfig(home);
  } catch (error) {
    if (error instanceof ClaudeConfigInvalid) {
      return "Claude Code's user config (~/.claude.json) is not valid JSON, so browser-tool was not added.";
    }
    throw error;
  }
  const edit = editClaudeUserConfig(current, browserToolEntry(extensionPath));
  if (edit.status === "invalid") {
    return "Claude Code's user config (~/.claude.json) is not a JSON object, so browser-tool was not added.";
  }
  if (edit.status === "conflict") {
    return "Claude Code already has an MCP server named browser-tool that points somewhere else. Remove that entry, then run this command again.";
  }
  if (edit.status === "unchanged") {
    return "browser-tool is already in Claude Code. Start a new Claude Code chat to use it.";
  }
  await saveClaudeUserConfig(home, edit.config);
  if (edit.status === "added") {
    return "Added browser-tool to Claude Code. Start a new Claude Code chat to use it.";
  }
  return "Updated the browser-tool path in Claude Code. Start a new Claude Code chat to use it.";
}

function registerVsCodeMcpServer(context: vscode.ExtensionContext, out: vscode.OutputChannel): vscode.Disposable | undefined {
  if (
    !vscode.lm ||
    typeof vscode.lm.registerMcpServerDefinitionProvider !== "function" ||
    typeof vscode.McpStdioServerDefinition !== "function"
  ) {
    out.appendLine("This VS Code version has no MCP server provider API, so browser-tool was not registered.");
    return undefined;
  }
  const version = typeof context.extension.packageJSON.version === "string" ? context.extension.packageJSON.version : undefined;
  try {
    return vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      provideMcpServerDefinitions: () => [
        new vscode.McpStdioServerDefinition(
          MCP_PROVIDER_ID,
          process.execPath,
          [context.asAbsolutePath(path.join("dist", "server.js"))],
          undefined,
          version,
        ),
      ],
    });
  } catch (error) {
    out.appendLine(`MCP server was not registered with VS Code: ${extensionError(error)}`);
    return undefined;
  }
}

async function offerClaudeCode(context: vscode.ExtensionContext, out: vscode.OutputChannel): Promise<void> {
  const home = os.homedir();
  let current: unknown;
  try {
    current = await readClaudeUserConfig(home);
  } catch (error) {
    out.appendLine(`Claude Code config was not updated: ${extensionError(error)}`);
    return;
  }
  const edit = editClaudeUserConfig(current, browserToolEntry(context.extensionPath));
  if (edit.status === "refreshed") {
    try {
      await saveClaudeUserConfig(home, edit.config);
      out.appendLine("Updated the browser-tool path in Claude Code.");
    } catch (error) {
      out.appendLine(`Claude Code config was not updated: ${extensionError(error)}`);
    }
    return;
  }
  if (edit.status !== "added" || context.globalState.get<boolean>(CLAUDE_OFFER_DISMISSED)) return;
  const major = await installedNodeMajor();
  if (major === undefined || major < 20) {
    out.appendLine("Skipped the Claude Code prompt because Node.js 20 or newer is not on PATH.");
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    "Add browser-tool to Claude Code? This writes your user MCP config so new Claude Code chats can use it.",
    { modal: true },
    "Add",
    "Not now",
  );
  if (choice === "Not now") {
    await context.globalState.update(CLAUDE_OFFER_DISMISSED, true);
    return;
  }
  if (choice !== "Add") return;
  try {
    const message = await addBrowserToolToClaudeCode(context.extensionPath);
    out.appendLine(message);
    void vscode.window.showInformationMessage(message);
  } catch (error) {
    out.appendLine(`Add to Claude Code failed: ${extensionError(error)}`);
    void vscode.window.showErrorMessage(`MCP Server: Browser: ${extensionError(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Browser Tool");
  const disposables: vscode.Disposable[] = [];
  const extId = context.extension.id;

  // Reading the proposed member is safe; the check happens on call. If it is
  // missing entirely (older/changed VS Code) we simply never start the bridge.
  const openTab = (vscode.window as { openBrowserTab?: OpenTabFn }).openBrowserTab;

  let bridge: TabBridge | null = null;

  const mcp = registerVsCodeMcpServer(context, out);
  if (mcp) disposables.push(mcp);

  const enable = (): Thenable<void> => enableProposal(extId, out);
  disposables.push(vscode.commands.registerCommand("browserTool.enableBrowserTabApi", enable));
  disposables.push(
    vscode.commands.registerCommand("browserTool.addToClaudeCode", async () => {
      try {
        const message = await addBrowserToolToClaudeCode(context.extensionPath);
        out.appendLine(message);
        void vscode.window.showInformationMessage(message);
      } catch (error) {
        const message = extensionError(error);
        out.appendLine(`Add to Claude Code failed: ${message}`);
        void vscode.window.showErrorMessage(`MCP Server: Browser: ${message}`);
      }
    }),
  );

  // Opens the GitHub bug form with a diagnostics draft. The draft is not
  // uploaded until the user submits it. See PRIVACY.md for the field list.
  disposables.push(
    vscode.commands.registerCommand("browserTool.reportIssue", async () => {
      const manifestBugs = context.extension.packageJSON?.bugs;
      const templateUrl =
        typeof manifestBugs === "object" &&
        manifestBugs &&
        typeof manifestBugs.url === "string" &&
        manifestBugs.url.startsWith("https://")
          ? manifestBugs.url
          : BUG_REPORT_URL;
      const diagnostics = buildDiagnostics({
        extensionVersion: String(context.extension.packageJSON.version ?? ""),
        vscodeVersion: vscode.version,
        appName: vscode.env.appName,
        uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
        remoteName: vscode.env.remoteName ?? "",
        platform: process.platform,
        arch: process.arch,
        browserTab: vscode.workspace.getConfiguration().get<boolean>(SETTING, false),
        browserApi: typeof openTab === "function",
      });
      const choice = await vscode.window.showInformationMessage(
        "Open a public GitHub issue? The draft includes the extension version, VS Code version and product name, whether the window is desktop or web, OS and CPU architecture, the remote type (not a hostname), the browser tab setting, and whether the integrated browser API is available. You can edit the draft before submitting. Nothing is uploaded until you create the issue.",
        { modal: true },
        "Open issue",
        "Copy diagnostics",
      );
      if (!choice) return;
      if (choice === "Copy diagnostics") {
        await vscode.env.clipboard.writeText(diagnostics);
        out.appendLine("Report Issue: diagnostics copied.");
        void vscode.window.showInformationMessage("MCP Server: Browser: diagnostics copied");
        return;
      }
      out.appendLine("Report Issue: opening GitHub issue draft.");
      const opened = await vscode.env.openExternal(vscode.Uri.parse(reportIssueUrl(templateUrl, diagnostics)));
      if (!opened) {
        await vscode.env.clipboard.writeText(diagnostics);
        void vscode.window.showErrorMessage(
          "MCP Server: Browser: could not open the browser. Diagnostics were copied — paste them into a GitHub issue.",
        );
      }
    }),
  );

  const update = (): void => {
    const enabled = vscode.workspace.getConfiguration().get<boolean>(SETTING, false);
    if (enabled && typeof openTab === "function" && !bridge) {
      try {
        bridge = new TabBridge(out, openTab, disposables);
        bridge.start();
      } catch (e) {
        bridge = null;
        out.appendLine(`Browser-tab integration unavailable: ${e instanceof Error ? e.message : String(e)}`);
        const action = "Add to argv.json";
        void vscode.window
          .showWarningMessage(
            `Browser-tab integration needs the 'browser' API proposal enabled for ${extId}.`,
            action,
          )
          .then((r) => {
            if (r === action) void enable();
          });
      }
    } else if (!enabled && bridge) {
      bridge.stop();
      bridge = null;
    }
  };

  context.subscriptions.push(
    out,
    ...disposables,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("browserTool")) update();
    }),
  );
  update();
  void offerClaudeCode(context, out);
}
