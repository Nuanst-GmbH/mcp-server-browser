/**
 * Page-target selection for the integrated browser CDP proxy.
 * Page methods are "Method not found" until they carry a page sessionId.
 */
import assert from "node:assert/strict";
import {
  cookiesFromDocument,
  isBrowserLevelMethod,
  pickPageTarget,
  readAttachedSessionId,
  readDocumentCookieDump,
  readEvaluateValue,
  readTargetInfos,
  type PageTargetInfo,
} from "../src/pageTarget";

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

const page = (targetId: string, url: string): PageTargetInfo => ({ targetId, type: "page", url });

test("returns true for Target and Browser methods", () => {
  assert.equal(isBrowserLevelMethod("Target.getTargets"), true);
  assert.equal(isBrowserLevelMethod("Browser.getVersion"), true);
});

test("returns false for page methods that need a sessionId", () => {
  assert.equal(isBrowserLevelMethod("Network.getCookies"), false);
  assert.equal(isBrowserLevelMethod("Runtime.evaluate"), false);
  assert.equal(isBrowserLevelMethod("Page.navigate"), false);
});

test("reads target infos and drops entries with no id", () => {
  const infos = readTargetInfos({
    targetInfos: [
      { targetId: "page-1", type: "page", url: "https://app.example/home" },
      { targetId: "", type: "page", url: "https://ignored.example/" },
      { type: "page" },
      { targetId: "worker-1", type: "worker", url: "" },
    ],
  });
  assert.deepEqual(infos, [
    { targetId: "page-1", type: "page", url: "https://app.example/home" },
    { targetId: "worker-1", type: "worker", url: "" },
  ]);
});

test("returns an empty list when target infos are missing", () => {
  assert.deepEqual(readTargetInfos({}), []);
  assert.deepEqual(readTargetInfos(null), []);
});

test("picks the page whose url matches the open tab", () => {
  const picked = pickPageTarget(
    [
      page("other", "https://other.example/"),
      { targetId: "worker-1", type: "worker", url: "https://app.example/home" },
      page("app", "https://app.example/home"),
    ],
    "https://app.example/home",
  );
  assert.equal(picked?.targetId, "app");
});

test("picks the first page when no url matches", () => {
  const picked = pickPageTarget(
    [
      { targetId: "browser", type: "browser" },
      page("first", "https://first.example/"),
      page("second", "https://second.example/"),
    ],
    "https://missing.example/",
  );
  assert.equal(picked?.targetId, "first");
});

test("returns undefined when the only targets are workers", () => {
  assert.equal(pickPageTarget([{ targetId: "worker-1", type: "worker" }], "https://app.example/"), undefined);
});

test("reads the sessionId returned by Target.attachToTarget", () => {
  assert.equal(readAttachedSessionId({ sessionId: "session-1" }), "session-1");
});

test("returns undefined when attachToTarget omits sessionId", () => {
  assert.equal(readAttachedSessionId({}), undefined);
  assert.equal(readAttachedSessionId({ sessionId: "" }), undefined);
});

test("reads the value from a Runtime.evaluate result", () => {
  assert.deepEqual(readEvaluateValue({ result: { type: "object", value: { hostname: "app.example" } } }), {
    hostname: "app.example",
  });
});

test("returns undefined when Runtime.evaluate threw", () => {
  assert.equal(
    readEvaluateValue({ result: { type: "object", value: {} }, exceptionDetails: { text: "boom" } }),
    undefined,
  );
});

test("maps document.cookie onto host-only twin cookies", () => {
  const dump = readDocumentCookieDump({
    hostname: "app.example",
    protocol: "https:",
    cookies: [
      { name: "session", value: "abc=def" },
      { name: "", value: "skip" },
      { name: "plain", value: "1" },
    ],
  });
  assert.deepEqual(cookiesFromDocument(dump!), [
    { name: "session", value: "abc=def", domain: "app.example", path: "/", secure: true, httpOnly: false },
    { name: "plain", value: "1", domain: "app.example", path: "/", secure: true, httpOnly: false },
  ]);
});

test("returns no cookies when the document has no hostname", () => {
  assert.deepEqual(
    cookiesFromDocument({ hostname: "", protocol: "https:", cookies: [{ name: "a", value: "b" }] }),
    [],
  );
});

test("marks document cookies insecure on http", () => {
  const [cookie] = cookiesFromDocument({
    hostname: "intranet",
    protocol: "http:",
    cookies: [{ name: "a", value: "b" }],
  });
  assert.equal(cookie.secure, false);
  assert.equal(cookie.httpOnly, false);
});

test("returns undefined when the document cookie dump is not an object", () => {
  assert.equal(readDocumentCookieDump("a=b"), undefined);
  assert.equal(readDocumentCookieDump({ hostname: "app.example", protocol: "https:" }), undefined);
});

if (failed > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
