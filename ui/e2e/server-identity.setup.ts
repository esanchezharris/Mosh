// Runs before every e2e spec (the "chromium" project depends on this setup project): the
// server on the e2e port must be Mosh's UI, or nothing runs. See serverIdentity.ts.
import { test, expect } from "@playwright/test";
import { foreignServerMessage, isMoshAppHtml } from "./serverIdentity";

test("the e2e server is Mosh's dev server", async ({ request, baseURL }) => {
  const response = await request.get("/");
  const html = await response.text();
  expect(isMoshAppHtml(html), foreignServerMessage(baseURL ?? "(no baseURL)", html)).toBe(true);
});
