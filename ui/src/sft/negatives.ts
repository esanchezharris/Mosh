// Grounding-negatives helpers (training program Stage 1.4, pre-registered in
// docs/bench/PROGRAM_STAGE1_2026-07.md §P3).
//
// A negative is a user request referencing a track/clip/section/audio file that
// does NOT exist in the live session; the gold behavior is the existing defer
// convention — {"intent":"HUH","say":"<short clarifying ask>"} — never acting on
// some other entity. A twin is the same phrasing rebound to a REAL entity, which
// flows through the normal answer→grade→keep path; the contrastive pair teaches
// the distinction (the measured failure: ~50% wrong-act on absent targets).
//
// Everything here is pure so the synthesis driver's negative mode is golden-tested
// without spawning the engine or calling the brain.

export type NegativePair = { absent: string; ask: string; grounded?: string };

// Collect every entity NAME visible in the snapshot (tracks, clips, sections,
// annotations…). Walks the object for `name` string properties — the snapshot
// schema nests these consistently. Lowercased, deduped, length ≥3 (short generic
// names would reject almost any sentence).
export function extractSessionNames(snap: unknown): string[] {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "name" && typeof v === "string" && v.trim().length >= 3) names.add(v.trim().toLowerCase());
      else walk(v);
    }
  };
  walk(snap);
  return [...names].sort();
}

// A candidate "absent" request is invalid if it names a real session entity.
// Plain case-insensitive substring match: over-rejection only loses a candidate,
// while under-rejection would mint a false HUH row — so err toward rejecting.
export function mentionsRealEntity(request: string, names: string[]): boolean {
  const r = request.toLowerCase();
  return names.some((n) => r.includes(n));
}

// The clarifying ask must be short (≤12 words) and non-empty, per §P3.
export function validAsk(ask: unknown): ask is string {
  if (typeof ask !== "string") return false;
  const words = ask.trim().split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 12;
}

// Parse the task-gen reply for negative mode. Accepts fenced or bare JSON of
// {"pairs":[{"absent":"...","ask":"...","grounded":"..."}]}; drops malformed
// entries rather than throwing (the caller reports counts).
export function parseNegativePairs(content: string): NegativePair[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
  } catch {
    return [];
  }
  const pairs = (parsed as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs)) return [];
  const out: NegativePair[] = [];
  for (const p of pairs) {
    if (!p || typeof p !== "object") continue;
    const { absent, ask, grounded } = p as Record<string, unknown>;
    if (typeof absent !== "string" || !absent.trim() || !validAsk(ask)) continue;
    out.push({
      absent: absent.trim(),
      ask: (ask as string).trim(),
      ...(typeof grounded === "string" && grounded.trim() ? { grounded: grounded.trim() } : {}),
    });
  }
  return out;
}

// The gold negative training row — exactly the buildDataset huh convention.
export function negativeRow(system: string, request: string, ask: string): { messages: Array<{ role: string; content: string }> } {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: request },
      { role: "assistant", content: JSON.stringify({ intent: "HUH", say: ask }) },
    ],
  };
}
