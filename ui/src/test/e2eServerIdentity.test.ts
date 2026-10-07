import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MOSH_APP_MARKER, describePage, foreignServerMessage, isMoshAppHtml, shouldReuseExistingServer,
} from "../../e2e/serverIdentity";

// The e2e harness's server guards (ui/e2e/serverIdentity.ts). The 2026-10-06 case: an
// unrelated project's Vite server on :5173 served a game page and the gate ran every spec
// against it.
const here = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(resolve(here, "../../index.html"), "utf8");
const FOREIGN = `<!doctype html><html><head><title>SPIRIT of the WEST · THE RANCH</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;

describe("the e2e server identity check", () => {
  it("Mosh's index.html carries the marker the check looks for", () => {
    expect(INDEX_HTML).toContain(MOSH_APP_MARKER);
    expect(isMoshAppHtml(INDEX_HTML)).toBe(true);
  });

  it("a foreign Vite app is refused even though it looks like a React dev page", () => {
    expect(isMoshAppHtml(FOREIGN)).toBe(false);
    expect(isMoshAppHtml("")).toBe(false);
    // a page that merely says "Mosh" is not the marker
    expect(isMoshAppHtml("<title>Mosh</title><div id=\"root\"></div>")).toBe(false);
  });

  it("the refusal names the port's page and how to recover, and never says to kill it", () => {
    const msg = foreignServerMessage("http://127.0.0.1:5173", FOREIGN);
    expect(msg).toContain("http://127.0.0.1:5173");
    expect(msg).toContain('a page titled "SPIRIT of the WEST · THE RANCH"');
    expect(msg).toContain("MOSH_E2E_PORT");
    expect(msg).toContain("do not stop the other process");
    expect(describePage("  no title here  ")).toBe('a page starting "no title here"');
    expect(describePage("")).toBe("an empty response");
  });
});

describe("whether Playwright may reuse a running server", () => {
  it("a developer's local run may reuse (the identity check then guards it)", () => {
    expect(shouldReuseExistingServer({})).toBe(true);
  });
  it("never when the gate owns the port, on CI, or for the preview lane", () => {
    expect(shouldReuseExistingServer({ MOSH_E2E_OWN_SERVER: "1" })).toBe(false);
    expect(shouldReuseExistingServer({ CI: "true" })).toBe(false);
    expect(shouldReuseExistingServer({ MOSH_E2E_PREVIEW: "1" })).toBe(false);
    expect(shouldReuseExistingServer({ MOSH_E2E_OWN_SERVER: "0" })).toBe(true);
  });
});
