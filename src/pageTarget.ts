// VS Code's integrated browser speaks CDP through a browser-level proxy.
// Browser.* and Target.* run on that session. Every other method (Runtime,
// Page, Network, Input) is rejected with "Method not found" until the caller
// attaches to a page target and sends the command with that sessionId.

export interface PageTargetInfo {
  targetId: string;
  type: string;
  url?: string;
}

export function isBrowserLevelMethod(method: string): boolean {
  return method.startsWith("Browser.") || method.startsWith("Target.");
}

export function readTargetInfos(result: unknown): PageTargetInfo[] {
  if (typeof result !== "object" || result === null) return [];
  if (!("targetInfos" in result) || !Array.isArray(result.targetInfos)) return [];
  const infos: PageTargetInfo[] = [];
  for (const item of result.targetInfos) {
    if (typeof item !== "object" || item === null) continue;
    if (!("targetId" in item) || typeof item.targetId !== "string" || item.targetId === "") continue;
    if (!("type" in item) || typeof item.type !== "string" || item.type === "") continue;
    const url = "url" in item && typeof item.url === "string" ? item.url : undefined;
    infos.push({ targetId: item.targetId, type: item.type, url });
  }
  return infos;
}

// Prefer the page whose URL is the tab the user is looking at. Anything that
// is not a page (workers, iframes, the browser target) cannot answer
// Runtime.evaluate or Network.getCookies for that document.
export function pickPageTarget(targets: readonly PageTargetInfo[], pageUrl?: string): PageTargetInfo | undefined {
  const pages = targets.filter((target) => target.type === "page");
  if (pageUrl) {
    const match = pages.find((target) => target.url === pageUrl);
    if (match) return match;
  }
  return pages[0];
}

export function readAttachedSessionId(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  if (!("sessionId" in result) || typeof result.sessionId !== "string" || result.sessionId === "") return undefined;
  return result.sessionId;
}

export function readEvaluateValue(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return undefined;
  if ("exceptionDetails" in result && result.exceptionDetails) return undefined;
  if (!("result" in result) || typeof result.result !== "object" || result.result === null) return undefined;
  if (!("value" in result.result)) return undefined;
  return result.result.value;
}

export const DOCUMENT_COOKIE_EXPRESSION =
  `(() => {
    const cookies = [];
    const raw = typeof document.cookie === "string" ? document.cookie : "";
    for (const part of raw.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      const name = eq < 0 ? trimmed : trimmed.slice(0, eq);
      const value = eq < 0 ? "" : trimmed.slice(eq + 1);
      if (name) cookies.push({ name, value });
    }
    return { hostname: location.hostname, protocol: location.protocol, cookies };
  })()`;

export interface DocumentCookieDump {
  hostname: string;
  protocol: string;
  cookies: { name: string; value: string }[];
}

export function readDocumentCookieDump(value: unknown): DocumentCookieDump | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("hostname" in value) || typeof value.hostname !== "string") return undefined;
  if (!("protocol" in value) || typeof value.protocol !== "string") return undefined;
  if (!("cookies" in value) || !Array.isArray(value.cookies)) return undefined;
  const cookies: { name: string; value: string }[] = [];
  for (const item of value.cookies) {
    if (typeof item !== "object" || item === null) continue;
    if (!("name" in item) || typeof item.name !== "string" || item.name === "") continue;
    if (!("value" in item) || typeof item.value !== "string") continue;
    cookies.push({ name: item.name, value: item.value });
  }
  return { hostname: value.hostname, protocol: value.protocol, cookies };
}

export interface PageScriptCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: false;
}

// document.cookie is host-only and never includes HttpOnly cookies. Callers
// must say so when this is the only source that worked.
export function cookiesFromDocument(dump: DocumentCookieDump): PageScriptCookie[] {
  if (!dump.hostname) return [];
  const secure = dump.protocol === "https:";
  return dump.cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: dump.hostname,
    path: "/",
    secure,
    httpOnly: false,
  }));
}
