// ─────────────────────────────────────────────────────────────────────────────
// GESTURE REACHABILITY — the shipped shell must honour its own gesture vocabulary.
//
// THE STRUCTURAL HOLE THIS CLOSES. `ui/src/agent/uiReachability.test.ts` proves every
// agent-catalog COMMAND is mouse-reachable from v2, and it holds at zero exceptions. But
// Mosh's seam doctrine (ARCHITECTURE.md §3, contract 2) deliberately keeps selection,
// marquee, snap, tool choice, zoom and drag UI-LOCAL — they are pure view state and are
// NOT commands, on purpose. So an entire class of DAW capability was invisible to every
// gate in this repo: no test could tell whether v2 could marquee-select at all, because
// marquee is not a command and never will be.
//
// That is why every lane stayed green while the shipped shell could not select more than
// one clip with the mouse.
//
// WHAT IT ASSERTS. `ui/src/interaction/` already IS the gesture ledger — `actions.ts` is
// the shared action vocabulary, `gestureTables.ts` maps region × gesture × modifier →
// action, `keymap.ts` maps action → combo. Nothing ever checked that the shipped shell
// implements what those tables promise. This asserts exactly that, against the MOSH
// table (the default, and the one `getGestureTable` falls back to).
//
// THE PROBE'S OWN TRAP, WHICH IT FELL INTO FIRST. The searched surface must EXCLUDE
// `ui/src/interaction/` — the tables mention every action and region by definition, and
// v2 imports them, so including them makes the whole test vacuous. (My first run of this
// scan reported all 13 actions present; excluding `interaction/` dropped it to 10 and
// surfaced the three real gaps.) This mirrors uiReachability.test.ts excluding
// `ui/src/agent`, which holds the command catalog, for exactly the same reason.
//
// WHY ACTIONS AND NOT REGIONS. An earlier draft also asserted that every table `region`
// resolves in v2. That check fails for `clip.edge` and `ruler` — but not because the
// capability is missing: v2 implements edge-trim and ruler seek/loop BY HAND
// (`v2/timeline/BarRuler.tsx`) instead of routing them through `resolveGesture`. That is
// a design observation, not a user-facing gap, and asserting on it would fail the gate
// for something a producer can already do. Actions are the capability; regions are an
// implementation detail.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GESTURE_TABLES } from "../interaction/gestureTables";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Gesture-table actions the MOSH table promises but the shipped v2 shell does not
 * implement. A RATCHET: entries may only be REMOVED. Adding one is a regression and
 * needs a reason a reviewer would accept, not a note that it was inconvenient.
 *
 * All three are the `empty` region — v2 has no empty-lane gesture handling at all.
 * Closing them is the marquee/selection wave.
 */
export const GESTURE_GAPS: Readonly<Record<string, string>> = {
  marquee:
    "no marquee/lasso select anywhere in ui/src/v2 — it exists only in the classic shell "
    + "(ui/src/ui/Arrange.tsx). A v2 producer cannot select more than one clip with the mouse, "
    + "which also makes Cmd+C/X/V and Delete single-clip in practice regardless of what they "
    + "support. This is the largest single beat-first gap.",
  deselect:
    "clicking an empty lane does not clear the selection in v2 — the empty region has no "
    + "pointer handler, so a selection can only be replaced, never dropped. Ships with marquee: "
    + "both need the same empty-lane gesture surface.",
  time_select:
    "the Range tool (keymap `3` -> tool_range) sets store.tool but v2 reads `tool` only in "
    + "ClipView for CLIP-region gestures, so dragging an empty lane in the range tool does "
    + "nothing and v2 shows no tool indicator to reveal the mode changed. Time selection IS "
    + "reachable in v2 by dragging the bar ruler (v2/timeline/BarRuler.tsx:110) — so this is a "
    + "missing lane gesture and an inert tool mode, not a missing capability.",
};

function resolveImport(fromDir: string, spec: string): string | null {
  const base = resolve(fromDir, spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")])
    if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** Every module transitively reachable from an entry point, via relative imports. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const re of [/\bfrom\s+"(\.[^"]+)"/g, /\bimport\s+"(\.[^"]+)"/g, /\bimport\(\s*"(\.[^"]+)"\s*\)/g])
      for (const m of src.matchAll(re)) {
        const next = resolveImport(dirname(file), m[1]);
        if (next) stack.push(next);
      }
  }
  return [...seen];
}

// Deliberately a private copy of the walk rather than an import from
// uiReachability.test.ts: that file is the target of an in-flight PR (#500) and is edited
// by concurrent sessions. ~20 duplicated lines buy independence from a merge conflict on
// a file this test only reads structurally.
const graph = moduleGraph(join(SRC, "v2", "AppV2.tsx"));
const searched = graph.filter((f) =>
  !f.startsWith(join(SRC, "agent"))         // the command catalog names everything
  && !f.startsWith(join(SRC, "interaction")) // the gesture tables name every action — see header
  && !f.endsWith("bridge.mock.ts"));         // the dev backend implements everything
const shell = searched.map((f) => readFileSync(f, "utf8")).join("\n");

const isImplemented = (action: string) =>
  shell.includes(`"${action}"`)
  || new RegExp(`\\b(?:EA|EditorAction)\\.${action.toUpperCase()}\\b`).test(shell);

const moshActions = [...new Set(GESTURE_TABLES.mosh.map((r) => r.action))];

describe("gesture reachability — the shipped shell honours its gesture table (GESTURE-REACH)", () => {
  it("the shell scan found real files (guards against a silently-empty probe)", () => {
    // Without these floors a broken walk reports zero gaps and reads exactly like success —
    // this repo's documented recurring failure. The exclusions must also actually exclude:
    // if `searched` ever equals `graph`, interaction/ leaked back in and every assertion
    // below is vacuous.
    expect(searched.length).toBeGreaterThan(100);
    expect(shell.length).toBeGreaterThan(200_000);
    expect(searched.length).toBeLessThan(graph.length);
    expect(moshActions.length).toBeGreaterThan(10);
    // Sanity: gestures we KNOW v2 implements must read as implemented, or the probe is broken.
    for (const a of ["move", "trim", "split", "select"])
      expect(isImplemented(a), `probe broken: ${a} is wired in v2 but read as missing`).toBe(true);
  });

  it("every MOSH gesture-table action is implemented in v2, or declared with a reason", () => {
    const undeclared = moshActions.filter((a) => !isImplemented(a) && !(a in GESTURE_GAPS));
    expect(
      undeclared,
      "These gestures are promised by ui/src/interaction/gestureTables.ts but the shipped v2 "
      + "shell implements nothing for them. A gesture is not a command, so NO other gate in "
      + "this repo can see this. Either implement the gesture, or add it to GESTURE_GAPS with "
      + "a reason.",
    ).toEqual([]);
  });

  it("every declared gap is still a gap (wiring one up must delete its entry)", () => {
    // The mirror of uiReachability's same check. A stale exception is worse than none: it
    // reads as a known limitation while the thing actually works, and it inflates the
    // ratchet so a real regression can hide inside the allowance.
    const stale = Object.keys(GESTURE_GAPS).filter((a) => isImplemented(a));
    expect(stale,
      "These are declared as gaps but now read as implemented — delete their GESTURE_GAPS entries.",
    ).toEqual([]);
  });

  it("every declared gap names a real action in the MOSH table", () => {
    const known = new Set<string>(moshActions);
    const bogus = Object.keys(GESTURE_GAPS).filter((a) => !known.has(a));
    expect(bogus, "GESTURE_GAPS names an action the MOSH table does not contain.").toEqual([]);
  });

  it("the gap list only shrinks (ratchet)", () => {
    // 3 on 2026-08-03 (marquee, deselect, time_select — the whole `empty` region).
    // Lower this number when you close one; never raise it.
    expect(Object.keys(GESTURE_GAPS).length).toBeLessThanOrEqual(3);
  });
});
