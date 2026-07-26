// UI-REACH — can a MOUSE-ONLY user reach each command?
//
// The gap this closes: the v2 shell (the default) shipped unable to create a drum track
// or a MIDI clip, and unable to rename a track. Every backend involved was complete and
// tested. 1,792 native selftest checks, 1,746 vitest tests and a "150/152 DAW-parity"
// scoreboard were all green throughout, because all of them assert that COMMANDS work —
// `conformance.py` even defines a pass as "capability proven HEADLESS". Nothing measured
// whether a human could get to the feature.
//
// So: every command the agent catalog exposes must either be referenced from the shipped
// shell, or be declared — with a reason — in AGENT_ONLY_COMMANDS (deliberate) or
// UI_REACH_GAPS (a backlog entry). A new command cannot become unreachable silently.
//
// The surface is computed as the MODULE GRAPH reachable from the v2 shell's entry point,
// not as a set of directories. That distinction is load-bearing, and I got it wrong first:
// a directory scan that included ui/src/ui counted `add_midi_clip` as reachable because
// classic's Topbar.tsx references it — but classic is NOT the default shell, so a command
// only reachable there is precisely the bug this test exists to catch. ui/src/ui is a
// SHARED component library (v2 imports 22 modules out of it) mixed in with classic-only
// files, so it can be neither wholly included nor wholly excluded. Walking imports from
// AppV2 resolves that exactly, and stays correct as files move between the two.
//
// Within that graph the probe is a string-literal search rather than a call-graph. That is
// deliberate: it is cheap, has no false NEGATIVES (a command genuinely wired up always
// mentions its name), and the dispatch idiom varies — `exec("x")`, `run("x")`,
// `command: "x"`, keymap and menu-action tables all appear in this codebase.
//
// WHAT THIS DOES NOT CATCH, stated plainly so nobody trusts it further than it goes.
// Module reachability is not user reachability. A command counts as reachable if its name
// appears in ANY module the v2 graph imports — even in a code path that never renders.
// This test is therefore a FLOOR — it catches a command with no reference anywhere in the
// shell graph (that is how it found all 22 originally) and ratchets the gap list — but it
// is not a substitute for a test of the specific gesture. High-value paths get their own:
// `v2/lanes/trackKinds.test.ts` pins the add-track wiring against the real mock backend.
//
// The worst instance of that floor leaking has now been closed, and it is worth recording
// how it looked, because it looked like success. `v2/lanes/ClipView.tsx` imports four
// PRESENTATIONAL exports from classic's `ui/Arrange.tsx`; the import drags the whole file
// (and everything only IT imports) into the graph. So `remove_track`, whose sole call site
// in the entire codebase is the × on classic's track header, and the three annotation
// commands, whose only call site is `ui/AnnotationRuler.tsx` — a component v2 never mounts —
// all read as REACHABLE. Four commands a mouse-only v2 user cannot get to, reported green.
// CLASSIC_ONLY_MODULES below is the fix: a declared boundary the walk does not cross.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_COMMANDS } from "./commands";
import { AGENT_ONLY_COMMANDS, UI_REACH_GAPS } from "./commandClassification";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent
const SRC = resolve(here, "..");

/** Resolve a relative import specifier the way Vite/TS would. */
function resolveImport(fromDir: string, spec: string): string | null {
  const base = resolve(fromDir, spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")])
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  return null;
}

// Modules the v2 graph pulls in for a HELPER but never renders. One entry = one path = one
// written reason, reviewed like UI_REACH_GAPS — not a convenience list.
//
// The walk STOPS at these rather than merely skipping them, because the leak is transitive:
// skipping Arrange.tsx alone still leaves `ui/AnnotationRuler.tsx` in the graph (Arrange is
// the only thing that imports it), and the annotation commands would keep reading as
// reachable. Stopping at the boundary drops the whole classic-only subtree — measured, that
// is Arrange.tsx plus RemotePlayheads.tsx, AnnotationRuler.tsx, TrackFxDrawer.tsx and
// laneLayout.ts.
//
// Excluding a file v2 partly renders risks a FALSE NEGATIVE, which would be worse than the
// leak. Checked before adding: the four exports v2 takes from Arrange.tsx (ClipWave,
// ClipMidi, ClipDrumGrid, isDrumClip — Arrange.tsx:710-800) are canvas/SVG drawing with no
// `exec(` and no store access at all, so they cannot be the only site of any command.
const CLASSIC_ONLY_MODULES: Readonly<Record<string, string>> = {
  "ui/Arrange.tsx":
    "classic's whole arrangement view. v2 imports only ClipWave/ClipMidi/ClipDrumGrid/isDrumClip " +
    "from it — presentational renderers that dispatch nothing — and mounts none of the file's own " +
    "UI. Everything Arrange itself renders (its track headers, ruler, clip menu, and the " +
    "AnnotationRuler + RemotePlayheads + TrackFxDrawer it pulls in) is unreachable in v2.",
};

/** Every module transitively reachable from an entry point, via relative imports.
 *  The walk does not cross a `stopAt` boundary: such a module is recorded, but its own
 *  imports are not followed, so a classic-only subtree does not enter the graph. */
function moduleGraph(entry: string, stopAt: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (stopAt.includes(file)) continue;
    const src = readFileSync(file, "utf8");
    // static `from "./x"`, bare side-effect `import "./x"`, and dynamic `import("./x")`
    for (const re of [/\bfrom\s+"(\.[^"]+)"/g, /\bimport\s+"(\.[^"]+)"/g, /\bimport\(\s*"(\.[^"]+)"\s*\)/g])
      for (const m of src.matchAll(re)) {
        const next = resolveImport(dirname(file), m[1]);
        if (next) stack.push(next);
      }
  }
  return [...seen];
}

// The DEFAULT shell. `ui/src/settings/schema.ts` defaults `uiShell` to "v2", and
// App.tsx mounts AppV2 for it — so this graph is what a shipped user actually touches.
// bridge.mock is the dev BACKEND (it implements every command); it is not in this graph,
// and including it would make everything look reachable — the exact mistake to avoid.
const classicOnly = Object.keys(CLASSIC_ONLY_MODULES).map((p) => join(SRC, p));
const graph = moduleGraph(join(SRC, "v2", "AppV2.tsx"), classicOnly);

// Two parts of the graph must be walked through but never SEARCHED, because each mentions
// every command name and would make the whole test vacuous:
//   • src/agent — the v2 shell hosts the agent panel, so the graph legitimately reaches the
//     CATALOG (commands.ts lists all 123 names) and this file's own gap map. Agent infra is
//     the agent's reach, not the user's.
//   • bridge.mock.ts — the dev BACKEND. It implements every command by definition; counting
//     it as a call site would report 100% reachability forever.
const EXCLUDED = (f: string) =>
  f.startsWith(join(SRC, "agent")) || f.endsWith("bridge.mock.ts") || classicOnly.includes(f);
const files = graph.filter((f) => !EXCLUDED(f));
const shell = files.map((f) => readFileSync(f, "utf8")).join("\n");

const isReachable = (command: string) => shell.includes(`"${command}"`);
const catalog = AGENT_COMMANDS.map((c) => c.command);

describe("UI reachability — a mouse-only user can get to every command (UI-REACH)", () => {
  it("the shell scan found real files (guards against a silently-empty probe)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(shell.length).toBeGreaterThan(200_000);
    // Sanity: commands we KNOW are wired must read as reachable, or the probe is broken
    // and every assertion below is vacuous.
    for (const c of ["create_track", "add_midi_clip", "rename_track", "export_audio", "set_transport"])
      expect(isReachable(c), `probe broken: ${c} is wired but read as unreachable`).toBe(true);
  });

  it("every declared classic-only boundary is real and load-bearing", () => {
    // A boundary that names a file which does not exist, or one the v2 graph never reached
    // anyway, silently excludes nothing while looking like it tightened the probe. That is
    // the same shape as the leak this whole mechanism exists to close, so it must fail.
    const unstopped = moduleGraph(join(SRC, "v2", "AppV2.tsx"));
    for (const rel of Object.keys(CLASSIC_ONLY_MODULES)) {
      const abs = join(SRC, rel);
      expect(existsSync(abs), `${rel} does not exist`).toBe(true);
      expect(unstopped.includes(abs), `${rel} is not in the v2 graph — excluding it does nothing`).toBe(true);
    }
    // And the exclusion must actually shrink the searched surface, or it is decoration.
    expect(files.length).toBeLessThan(unstopped.filter((f) => !f.startsWith(join(SRC, "agent")) && !f.endsWith("bridge.mock.ts")).length);
  });

  it("every catalog command is reachable, or declared with a reason", () => {
    const undeclared = catalog.filter(
      (c) => !isReachable(c) && !(c in AGENT_ONLY_COMMANDS) && !(c in UI_REACH_GAPS),
    );
    expect(
      undeclared,
      `These commands have no shipped-UI call site and no entry in AGENT_ONLY_COMMANDS or ` +
      `UI_REACH_GAPS. Either wire up a control, or add one with a one-line reason.`,
    ).toEqual([]);
  });

  it("a command is never in both classification maps", () => {
    const both = Object.keys(AGENT_ONLY_COMMANDS).filter((c) => c in UI_REACH_GAPS);
    expect(both).toEqual([]);
  });

  it("every declared gap is STILL a gap — wiring one up must delete its entry", () => {
    const fixed = Object.keys(UI_REACH_GAPS).filter((c) => isReachable(c));
    expect(
      fixed,
      `These are listed in UI_REACH_GAPS but now have a shipped-UI reference. Delete their ` +
      `entries — the list is the backlog, and a stale entry hides real progress.`,
    ).toEqual([]);
  });

  it("both maps only describe commands that actually exist", () => {
    const known = new Set(catalog);
    const strays = [...Object.keys(AGENT_ONLY_COMMANDS), ...Object.keys(UI_REACH_GAPS)]
      .filter((c) => !known.has(c));
    expect(strays, "declared for a command that is not in AGENT_COMMANDS").toEqual([]);
  });

  it("every declared entry carries a non-trivial reason", () => {
    for (const [c, why] of [...Object.entries(AGENT_ONLY_COMMANDS), ...Object.entries(UI_REACH_GAPS)])
      expect(why.length, `${c}'s reason is too thin to be useful`).toBeGreaterThan(25);
  });

  // THE RATCHET. This number may only ever go DOWN. Raising it means shipping another
  // feature the user cannot reach — which is the exact failure this test was written for.
  it("the gap list does not grow", () => {
    // 21 → 17 (SectionRibbon mounted: create/rename/move/remove_section) → 16
    // (DrumSequencer's Pattern field: add_drum_pattern) → 15 (list_takes, which was never
    // a gap: it re-reads take data the snapshot already carries, so it moved to
    // AGENT_ONLY_COMMANDS instead of being closed by building a duplicate control)
    // → 14 (GenDrawer's A/B toggle: bypass_layer — its two siblings stay, with reasons
    // rewritten to say what investigation found rather than what was assumed)
    // → 13 (ExportControls' stems mode: export_stems)
    // → 11 (the timeline's tempo lane: insert_tempo_change + remove_tempo_change)
    // → 7  (the asymmetries: rename_bus, remove_bus, set_master_plugin_param, and the
    //       classic-only add_test_tone_clip — each a control missing from a panel that
    //       already shipped its siblings).
    // Tightening on each close is the point — leaving slack banks gaps and lets the next
    // regression land unnoticed.
    //
    // → 11. THE ONE LEGITIMATE RISE, and it is a correction rather than a regression: adding
    // CLASSIC_ONLY_MODULES stopped the probe searching classic's Arrange.tsx subtree, which
    // exposed four commands (remove_track + the three annotation ones) that a v2 user never
    // could reach and that this test had been reporting green. Nothing got worse; the number
    // got honest. A probe change is the ONLY reason this line may go up — if it rises for any
    // other reason, a feature shipped that the user cannot get to.
    // → 10 (the sample browser's "Beatbox → beat" entry point: sketch_beatbox — the
    //       clipId-based clip menu was never a fit, since cmdSketchBeatbox takes an
    //       absolute path; SampleBrowser's directory listing already had one).
    expect(Object.keys(UI_REACH_GAPS).length).toBeLessThanOrEqual(10);
  });
});
