/**
 * Dead-session classification. A stale WebView target answers every command
 * with "Method not found"; an optional CDP domain does the same on a live target.
 */
import assert from "node:assert/strict";
import { isDeadCdpSessionMessage } from "../src/cdpSession";

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

test("returns true when Runtime.evaluate reports Method not found", () => {
  assert.equal(isDeadCdpSessionMessage("Method not found: Runtime.evaluate", "Runtime.evaluate"), true);
});

test("returns true when Page.navigate reports Method not found", () => {
  assert.equal(isDeadCdpSessionMessage("Method not found: Page.navigate", "Page.navigate"), true);
});

test("returns true when Input.dispatchMouseEvent was not found", () => {
  assert.equal(isDeadCdpSessionMessage("'Input.dispatchMouseEvent' wasn't found", "Input.dispatchMouseEvent"), true);
});

test("returns false when Network.getCookies is not implemented", () => {
  assert.equal(isDeadCdpSessionMessage("Method not found: Network.getCookies", "Network.getCookies"), false);
  assert.equal(isDeadCdpSessionMessage("Unknown method: Network.getCookies", "Network.getCookies"), false);
});

test("returns true when the execution context was destroyed", () => {
  assert.equal(isDeadCdpSessionMessage("Execution context was destroyed.", "Runtime.evaluate"), true);
});

test("returns true when the inspected target is gone", () => {
  assert.equal(isDeadCdpSessionMessage("Inspected target closed", "Page.navigate"), true);
});

test("returns true when the message says no CDP session is attached", () => {
  assert.equal(
    isDeadCdpSessionMessage("no CDP session attached to the integrated tab", "Runtime.evaluate"),
    true,
  );
});

test("returns true when sendMessage failed", () => {
  assert.equal(isDeadCdpSessionMessage("CDP session send failed: channel closed", "Page.captureScreenshot"), true);
});

test("returns true when the bridge connection closed before a reply", () => {
  assert.equal(isDeadCdpSessionMessage("connection closed before a reply"), true);
});

test("returns true when the method is omitted and the message is Method not found", () => {
  assert.equal(isDeadCdpSessionMessage("Method not found: Page.navigate"), true);
});

test("returns false when Storage.getCookies is not implemented", () => {
  assert.equal(isDeadCdpSessionMessage("Method not found: Storage.getCookies", "Storage.getCookies"), false);
});

test("returns false when the method name has no CDP domain", () => {
  assert.equal(isDeadCdpSessionMessage("Method not found", "not-a-cdp-method"), false);
});

test("returns false when no element matches the selector", () => {
  assert.equal(isDeadCdpSessionMessage("No element found for selector: #submit"), false);
});

test("returns false when a CDP command times out", () => {
  assert.equal(isDeadCdpSessionMessage("CDP Runtime.evaluate timed out after 30000ms", "Runtime.evaluate"), false);
});

test("returns false when the wait_for deadline expires", () => {
  assert.equal(isDeadCdpSessionMessage("Timeout after 15000ms waiting for #ready"), false);
});

test("returns false when the message is empty", () => {
  assert.equal(isDeadCdpSessionMessage(""), false);
});

if (failed > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
