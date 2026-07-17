// Pure view-model for the generative drawer's SA3/preview engine badge (guest-clarity, 2026-07-16).
//
// Keeps the derivation out of the React component so it's unit-testable without rendering,
// mirroring the qaReadout.ts pattern. The problem this fixes: on a guest Mac without the real
// Stable Audio 3 model installed, renders silently fall back to the deterministic FakeAdapter —
// but the FakeAdapter still returns a populated colour rack, so the old UI proxy
// (`colorsAvail.length > 0` ⇒ "stable audio 3") lied. `/colors` now reports the ground truth
// directly (server.py's `sa3` field, from the SA3_ENABLED module flag), threaded through
// list_colors verbatim; this module turns that into display copy.

export type EngineBadgeView = { label: "SA3" | "preview"; title: string };

const SA3_TITLE = "Renders use the real Stable Audio 3 model on this Mac";
const PREVIEW_TITLE =
  "Renders use a fast preview engine — run setup-guest.sh (in the app bundle) to install the real model";

/** Resolve whether SA3 is actually available on this Mac's service. `sa3Available` is the
 *  /colors `sa3` field (undefined ⇒ an old service that predates the field); `colorsAvailLength`
 *  is the pre-existing proxy (a non-empty colour rack), kept only as a fallback for old-service
 *  tolerance so a stale build doesn't regress to "always fake". */
export function resolveSa3Available(sa3Available: boolean | undefined, colorsAvailLength: number): boolean {
  return sa3Available ?? colorsAvailLength > 0;
}

/** Drawer-header badge copy for the resolved SA3-availability boolean. */
export function engineBadgeView(sa3: boolean): EngineBadgeView {
  return sa3 ? { label: "SA3", title: SA3_TITLE } : { label: "preview", title: PREVIEW_TITLE };
}

/** Per-render "who actually rendered this" line, from the completed render's own manifest
 *  (`qa.adapter`) — the truth for THIS render, independent of what the drawer would create next.
 *  Only surfaced for the fake engine: a real-SA3 render needs no explanation (the expected
 *  case), while a fake one is the surprising case worth a quiet callout (progressive disclosure). */
export function renderedByLabel(adapter: string | null | undefined): string | null {
  return adapter === "fake" ? "rendered by preview engine" : null;
}
