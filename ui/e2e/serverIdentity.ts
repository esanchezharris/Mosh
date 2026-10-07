// Which server the e2e suite may run against. Pure (no Playwright import), so the config,
// the identity setup project and a vitest unit test all share it.
//
// 2026-10-06: the gate's e2e step ran the whole suite against an unrelated project's Vite
// server that was already listening on 127.0.0.1:5173 (a game page, "SPIRIT of the WEST"),
// because Playwright's webServer reuses whatever answers on its url. 542 specs failed on a
// tree that passes. The same reuse could just as well make a gate PASS against a stale Mosh
// dev server from another worktree. Two guards, both needed:
//   1. the gate reserves a port block of its own and sets MOSH_E2E_OWN_SERVER=1, so
//      Playwright never reuses a server there: it starts this tree's, or refuses a busy port;
//   2. everywhere else (a developer reusing their running dev server), the
//      "mosh-server-identity" setup project checks the served page carries the Mosh marker
//      before a single spec runs, and names the foreign page when it does not.

/** The marker ui/index.html carries. Vite keeps head meta tags as written. */
export const MOSH_APP_MARKER = '<meta name="mosh-app" content="ui"';

/** True when `html` is Mosh's own UI page (dev server or built bundle). */
export function isMoshAppHtml(html: string): boolean {
  return html.includes(MOSH_APP_MARKER);
}

/** A short description of a page for the refusal message: its <title>, else its start. */
export function describePage(html: string): string {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  if (title) return `a page titled "${title}"`;
  const start = html.replace(/\s+/g, " ").trim().slice(0, 80);
  return start ? `a page starting "${start}"` : "an empty response";
}

/** The refusal shown when the server on the e2e port is not Mosh's. */
export function foreignServerMessage(baseURL: string, html: string): string {
  return (
    `The e2e server at ${baseURL} is not Mosh's dev server: it serves ${describePage(html)}. ` +
    `Another process owns that port. Set MOSH_E2E_PORT to a free port (Playwright then starts ` +
    `this tree's dev server there); do not stop the other process.`
  );
}

/** Whether Playwright may reuse a server already listening on the e2e port. Never on CI,
 *  never for the preview lane, and never when the caller (the gate) owns the port and
 *  wants this tree's server: MOSH_E2E_OWN_SERVER=1. */
export function shouldReuseExistingServer(env: Record<string, string | undefined>): boolean {
  return !env.CI && env.MOSH_E2E_PREVIEW !== "1" && env.MOSH_E2E_OWN_SERVER !== "1";
}
