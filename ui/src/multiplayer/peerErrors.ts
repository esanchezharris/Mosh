import type { PeerInfo } from "./sync";

// #40 (EDGECASE_SWEEP_V2_2026-07-18) — the native LockManager denies a mutation with
// `"locked by <peer-uuid>"` (src/multiplayer/LockManager.cpp), and that raw UUID used
// to reach the error bar verbatim. This is the DISPLAY-side fix: substitute any peer
// id we know from live presence with the peer's display name. Pure + display-only —
// the underlying message (logs, JSONL) is untouched, and unknown ids pass through so
// we never hide information we can't improve on.
export function formatPeerError(message: string, peers: Record<string, PeerInfo>): string {
  let out = message;
  for (const [id, p] of Object.entries(peers)) {
    if (!p?.name || !id) continue;
    // Whole-token matches only — a short id like the mock's "me"/"bo" must never
    // rewrite the inside of a word ("volume", "bounce"). Token chars are the id
    // alphabet itself (UUID hex + hyphen + word chars); anything else is a boundary.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(^|[^\\w-])${escaped}(?=$|[^\\w-])`, "g"),
      (_m, pre: string) => pre + p.name,
    );
  }
  return out;
}
