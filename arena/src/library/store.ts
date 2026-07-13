// A tiny observable store for the wall: candidates (seeds + generated), the human's
// verdicts (promote/cull), and the saved library (persisted). The library is the
// deliverable that flows into ui/src/v2 — winners saved with full provenance.

import { useSyncExternalStore } from "react";
import { SEED } from "../candidates/seed";
import type { Candidate, Target } from "../models/types";

export type Verdict = "promoted" | "culled";
export type View = "grid" | "avb";

export interface ArenaState {
  candidates: Candidate[];
  verdicts: Record<string, Verdict | undefined>;
  library: Candidate[];
  view: View;
  mode: 0 | 1 | 2; // fixture the waveform candidates render
  filter: Target | "all";
  /** provenance filter: 'all' or an exact Candidate.model value */
  designer: string;
}

const LIB_KEY = "mosh-arena-library-v1";
// v2 (2026-07-12): the consolidation cleanout. Bumping the key orphans every device's
// pre-cleanout cache so syncWithServer's local-only PUSH can't resurrect the archived wall
// (the old wall lives in .arena-generated.archive-2026-07-12.json).
const GEN_KEY = "mosh-arena-generated-v2";
const VERD_KEY = "mosh-arena-verdicts-v1";
// Consolidation: the in-code seed set stays in the repo for reference but is off the wall —
// the wall is the two winners (Rail + Monument) and whatever gets generated after the reset.
const SHOW_SEEDS = false;
const WALL_SEEDS = SHOW_SEEDS ? SEED : [];
const SEED_IDS = new Set(SEED.map((c) => c.id));

/** verdicts carry a timestamp so devices can merge last-write-wins */
type VerdictEntry = { v: Verdict | null; at: number };

function loadVerdictTimes(): Record<string, VerdictEntry> {
  try {
    const raw = localStorage.getItem(VERD_KEY);
    return raw ? (JSON.parse(raw) as Record<string, VerdictEntry>) : {};
  } catch {
    return {};
  }
}
function persistVerdictTimes(map: Record<string, VerdictEntry>) {
  try {
    localStorage.setItem(VERD_KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled */
  }
}
function verdictsFromTimes(map: Record<string, VerdictEntry>): Record<string, Verdict | undefined> {
  const out: Record<string, Verdict | undefined> = {};
  for (const [id, e] of Object.entries(map)) if (e && e.v) out[id] = e.v;
  return out;
}

function loadLibrary(): Candidate[] {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    return raw ? (JSON.parse(raw) as Candidate[]) : [];
  } catch {
    return [];
  }
}

// Model-generated candidates persist across reloads (the seed set is always present in
// code). So a Summon batch is still on the wall when you come back.
function loadGenerated(): Candidate[] {
  try {
    const raw = localStorage.getItem(GEN_KEY);
    const arr = raw ? (JSON.parse(raw) as Candidate[]) : [];
    return arr.filter((c) => !SEED_IDS.has(c.id));
  } catch {
    return [];
  }
}
function persistGenerated(candidates: Candidate[]) {
  try {
    localStorage.setItem(GEN_KEY, JSON.stringify(candidates.filter((c) => !SEED_IDS.has(c.id))));
  } catch {
    /* quota / disabled — session-only is fine */
  }
}

let verdictTimes: Record<string, VerdictEntry> = loadVerdictTimes();

let state: ArenaState = {
  candidates: [...loadGenerated(), ...WALL_SEEDS],
  verdicts: verdictsFromTimes(verdictTimes),
  library: loadLibrary(),
  view: "grid",
  mode: 0,
  filter: "all",
  designer: "all",
};

const subs = new Set<() => void>();
function emit() {
  for (const fn of subs) fn();
}
function set(patch: Partial<ArenaState>) {
  state = { ...state, ...patch };
  emit();
}

function persistLibrary(lib: Candidate[]) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  } catch {
    /* quota / disabled — session-only is fine */
  }
  // best-effort: also write a git-committable JSON to arena/library/ via the proxy.
  // Silent no-op if the endpoint isn't there.
  void fetch("/api/arena/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lib[lib.length - 1] ?? {}),
  }).catch(() => {});
}

// ── Durable, cross-device store ─────────────────────────────────────────────
// Generated candidates also live SERVER-SIDE (arena/.arena-generated.json via the proxy) so
// EVERY browser/device — including the iPhone over the LAN — loads the FULL wall, not just the
// browser that happened to generate a candidate. localStorage stays a fast local cache.
function pushToServer(cands: Candidate[]) {
  const fresh = cands.filter((c) => !SEED_IDS.has(c.id));
  if (!fresh.length) return;
  void fetch("/api/arena/generated", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fresh),
  }).catch(() => {});
}
// Two-way reconcile at startup: PULL server candidates we lack (this is how a fresh device /
// the iPhone fills up) and PUSH local-only candidates the server is missing (one-time
// migration of anything that predates server persistence + resilience).
async function syncWithServer() {
  let serverCands: Candidate[] = [];
  try {
    const r = await fetch("/api/arena/generated");
    if (!r.ok) return;
    serverCands = ((await r.json()).candidates as Candidate[]) || [];
  } catch {
    return; // no server reachable — localStorage-only is fine
  }
  const serverIds = new Set(serverCands.map((c) => c.id));
  // the SERVER is authoritative for any id it holds (candidates are updated in place
  // there — e.g. a verify pass patching sources); local copies refresh to match.
  const byId = new Map(state.candidates.map((c) => [c.id, c]));
  let changed = false;
  const toAdd: Candidate[] = [];
  for (const sc of serverCands) {
    if (!sc || !sc.id || SEED_IDS.has(sc.id)) continue;
    const cur = byId.get(sc.id);
    if (!cur) { toAdd.push(sc); changed = true; }
    else if (cur.source !== sc.source || cur.notes !== sc.notes || cur.title !== sc.title) {
      byId.set(sc.id, { ...cur, ...sc });
      changed = true;
    }
  }
  if (changed) {
    const merged = [...toAdd, ...state.candidates.map((c) => byId.get(c.id) ?? c)];
    set({ candidates: merged });
    persistGenerated(merged);
  }
  const localOnly = state.candidates.filter((c) => !SEED_IDS.has(c.id) && !serverIds.has(c.id));
  if (localOnly.length) pushToServer(localOnly);

  // ── verdicts: merge last-write-wins in both directions ──
  try {
    const r = await fetch("/api/arena/verdicts");
    if (!r.ok) return;
    const serverV = ((await r.json()).verdicts ?? {}) as Record<string, VerdictEntry>;
    let localChanged = false;
    const toPush: { id: string; v: Verdict | null; at: number }[] = [];
    const merged: Record<string, VerdictEntry> = { ...verdictTimes };
    for (const [id, se] of Object.entries(serverV)) {
      const le = merged[id];
      if (!le || se.at > le.at) { merged[id] = se; localChanged = true; }
    }
    for (const [id, le] of Object.entries(verdictTimes)) {
      const se = serverV[id];
      if (!se || le.at > se.at) toPush.push({ id, v: le.v, at: le.at });
    }
    if (localChanged) {
      verdictTimes = merged;
      persistVerdictTimes(verdictTimes);
      set({ verdicts: verdictsFromTimes(verdictTimes) });
    }
    if (toPush.length) {
      void fetch("/api/arena/verdicts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: toPush }),
      }).catch(() => {});
    }
  } catch {
    /* verdicts sync is best-effort */
  }
}

export const arena = {
  get: () => state,
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  addCandidates(cs: Candidate[]) {
    if (cs.length === 0) return;
    // newest first, de-dupe by id
    const seen = new Set(state.candidates.map((c) => c.id));
    const fresh = cs.filter((c) => !seen.has(c.id));
    const candidates = [...fresh, ...state.candidates];
    set({ candidates });
    persistGenerated(candidates);
    pushToServer(fresh);
  },
  flag(id: string, reason: string) {
    const candidates = state.candidates.map((c) => (c.id === id && !c.flag ? { ...c, flag: reason } : c));
    set({ candidates });
    persistGenerated(candidates);
    const updated = candidates.find((c) => c.id === id);
    if (updated) pushToServer([updated]);
  },
  setVerdict(id: string, v: Verdict | undefined) {
    const entry: VerdictEntry = { v: v ?? null, at: Date.now() };
    verdictTimes = { ...verdictTimes, [id]: entry };
    persistVerdictTimes(verdictTimes);
    set({ verdicts: { ...state.verdicts, [id]: v } });
    // judging must never be lost with the tab — push every tap to the server
    void fetch("/api/arena/verdicts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, v: entry.v, at: entry.at }),
    }).catch(() => {});
  },
  clearVerdicts() {
    verdictTimes = {};
    persistVerdictTimes(verdictTimes);
    set({ verdicts: {} });
    void fetch("/api/arena/verdicts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearAll: true }),
    }).catch(() => {});
  },
  saveToLibrary(c: Candidate) {
    if (state.library.some((x) => x.id === c.id)) return;
    const lib = [...state.library, { ...c, savedAt: Date.now() } as Candidate];
    set({ library: lib });
    persistLibrary(lib);
  },
  removeFromLibrary(id: string) {
    const lib = state.library.filter((c) => c.id !== id);
    set({ library: lib });
    persistLibrary(lib);
  },
  setView(view: View) {
    set({ view });
  },
  setMode(mode: 0 | 1 | 2) {
    set({ mode });
  },
  setFilter(filter: Target | "all") {
    set({ filter });
  },
  setDesigner(designer: string) {
    set({ designer });
  },
};

export function useArena<T>(selector: (s: ArenaState) => T): T {
  return useSyncExternalStore(arena.subscribe, () => selector(state));
}

// dev-only: expose the store for manual verification (e.g. injecting a deliberately-bad
// candidate to prove the sandbox contains it). Never referenced by production code.
if (import.meta.env.DEV) (globalThis as unknown as { arena: typeof arena }).arena = arena;

// Reconcile with the server-side wall on startup (fills a fresh device from the server;
// migrates local-only candidates up). Fire-and-forget — the seeds + localStorage render first.
void syncWithServer();

/** Pure derivation: candidates after the target + designer filters, culled ones sorted
 *  to the back. Call this inside a component useMemo over the raw slices — NOT as a
 *  useSyncExternalStore selector (a fresh array each snapshot loops). */
export function computeVisible(
  candidates: Candidate[],
  verdicts: ArenaState["verdicts"],
  filter: ArenaState["filter"],
  designer: string = "all",
): Candidate[] {
  let list = filter === "all" ? candidates : candidates.filter((c) => c.target === filter);
  if (designer !== "all") list = list.filter((c) => c.model === designer);
  return [...list].sort((a, b) => {
    const av = verdicts[a.id] === "culled" ? 1 : 0;
    const bv = verdicts[b.id] === "culled" ? 1 : 0;
    return av - bv;
  });
}

/** Short human label for a Candidate.model provenance string (dropdown + chips). */
export function designerLabel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("fable")) return "FABLE ✦";
  if (m === "seed" || m.includes("opus-insession")) return "OPUS SEEDS";
  if (m.includes("opus")) return "OPUS 4.8";
  if (m.startsWith("gpt") || m.startsWith("o")) return "GPT-5";
  if (m.includes("grok")) return "GROK";
  if (m.includes("sonnet")) return "SONNET 4.5";
  if (m.includes("deepseek")) return "DEEPSEEK";
  if (m.includes("moonshot") || m.includes("kimi")) return "KIMI";
  if (m.includes("gemini")) return "GEMINI";
  return model.toUpperCase().slice(0, 14);
}
