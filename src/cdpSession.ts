// A dead page target still has a BrowserCDPSession object. Commands then fail
// with CDP's own "Method not found" (or a destroyed execution context).
// The same text is also how the browser-level proxy rejects a page method that
// was sent without a page sessionId, and how an optional method such as
// Network.getCookies reports that it is unimplemented. Those cases must not
// drop the session: only methods a live page is expected to answer count.

const METHOD_MISSING = /method not found|wasn't found|unknown method/i;

const DEAD_TARGET =
  /execution context was destroyed|cannot find context with id|target closed|session closed|session with given id not found|inspector detached|websocket|connection closed|channel closed|no cdp session attached|cdp session send failed/i;

const CORE_DOMAINS = new Set(["Runtime", "Page", "Input"]);

export function isDeadCdpSessionMessage(message: string, method?: string): boolean {
  if (DEAD_TARGET.test(message)) return true;
  if (!METHOD_MISSING.test(message)) return false;
  if (method === undefined) return true;
  const dot = method.indexOf(".");
  if (dot <= 0) return false;
  return CORE_DOMAINS.has(method.slice(0, dot));
}
