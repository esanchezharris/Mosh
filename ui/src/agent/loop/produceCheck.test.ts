// produceCheck.test.ts — proves the round-2 correction's machine checks against
// the ACTUAL runs that produced the round-1 verdict (docs/produce-corrections/
// produce-r1-2026-09-02.meta.json). The three fixtures under
// __fixtures__/produce-r1/ are the real brain-replies.jsonl from
// ~/Library/Mosh/produce-ab/2026-09-02/runs/{live3-sonnet,live4-opus,live5-sonnet}
// (ts/ms/content only — userTail stripped, it's a large repeated system tail the
// checks never need). Per the plan: run 4 (opus) stopped its drum clip at bar 4
// (maxEnd 16 beats, well before beat 28); run 3 (live3-sonnet) used only 4 of the
// 10 drum pads; all three runs' chord/arp/lead/counter/stab tracks clash hard
// against the moving 808 root (the exact "timing / wrong notes" the owner heard) —
// this is what produceCheck.ts must catch so a repair step can fire before "done".

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkProduceRun, renderCheckAsRepairError, type CheckInput, type CheckNote } from "./produceCheck";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "../__fixtures__/produce-r1");

// The three runs share one template (verified against each run's own
// template.json): same key, same 9 tracks/roles, same 10-pad drum map.
const KEY = { tonic: "D", mode: "minor" };
const ROLES: Record<string, string> = {
  "1010": "drums",
  "1014": "808",
  "1018": "lead",
  "1022": "chords_pad",
  "1026": "drone",
  "1030": "counter",
  "1034": "arp",
  "1038": "ambient",
  "1042": "stab",
};
const PADS = [36, 37, 38, 39, 40, 41, 42, 43, 44, 46];

type FixtureLine = { ts: number; ms: number; content: string };
type FixtureCommand = { command: string; args: { trackId: string; notes?: CheckNote[] } };
type FixtureReply = { commands?: FixtureCommand[] };

/** Replay a run's brain-replies.jsonl into a CheckInput — exactly what a driver
 *  would hand produceCheck.ts after the real loop finished a live run: every
 *  add_midi_clip command's notes, grouped by trackId. */
function loadRunAsCheckInput(runId: string): CheckInput {
  const path = join(FIXTURES_DIR, `${runId}.brain-replies.jsonl`);
  const raw = readFileSync(path, "utf8");
  const tracks: Record<string, CheckNote[]> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as FixtureLine;
    let reply: FixtureReply;
    try {
      reply = JSON.parse(rec.content) as FixtureReply;
    } catch {
      continue; // a non-JSON or partial line — never expected in these fixtures
    }
    for (const cmd of reply.commands ?? []) {
      if (cmd.command !== "add_midi_clip" || !cmd.args?.notes) continue;
      const list = tracks[cmd.args.trackId] ?? (tracks[cmd.args.trackId] = []);
      list.push(...cmd.args.notes);
    }
  }
  return { key: KEY, roles: ROLES, tracks, pads: PADS, bars: 8 };
}

describe("produceCheck fixtures exist (real round-1 runs, not invented data)", () => {
  it("all three brain-replies.jsonl fixtures are present", () => {
    for (const runId of ["live3-sonnet", "live4-opus", "live5-sonnet"]) {
      expect(existsSync(join(FIXTURES_DIR, `${runId}.brain-replies.jsonl`)), runId).toBe(true);
    }
  });
});

describe("checkProduceRun against the round-1 runs", () => {
  it("run 4 (opus) trips stops_early on the drums track — the clip stopped at bar 4", () => {
    const report = checkProduceRun(loadRunAsCheckInput("live4-opus"));
    expect(report.ok).toBe(false);
    const stopsEarly = report.problems.filter((p) => p.code === "stops_early");
    expect(stopsEarly.length).toBeGreaterThan(0);
    expect(stopsEarly.some((p) => p.trackId === "1010")).toBe(true); // drums trackId
  });

  it("run 3 (live3-sonnet) trips few_pads on the drums track — only kick/snare/clap/hat used", () => {
    const report = checkProduceRun(loadRunAsCheckInput("live3-sonnet"));
    expect(report.ok).toBe(false);
    const fewPads = report.problems.filter((p) => p.code === "few_pads");
    expect(fewPads.length).toBe(1);
    expect(fewPads[0]!.trackId).toBe("1010");
  });

  it("run 4 (opus) does NOT trip few_pads — it used all 10 pads", () => {
    const report = checkProduceRun(loadRunAsCheckInput("live4-opus"));
    expect(report.problems.some((p) => p.code === "few_pads")).toBe(false);
  });

  it("run 3 (live3-sonnet) does NOT trip stops_early on drums — only run 4's clip stopped short", () => {
    const report = checkProduceRun(loadRunAsCheckInput("live3-sonnet"));
    expect(report.problems.some((p) => p.code === "stops_early" && p.trackId === "1010")).toBe(false);
  });

  it("all three runs trip at least one harmony_clash — the owner's 'timing / wrong notes'", () => {
    for (const runId of ["live3-sonnet", "live4-opus", "live5-sonnet"]) {
      const report = checkProduceRun(loadRunAsCheckInput(runId));
      const clashes = report.problems.filter((p) => p.code === "harmony_clash");
      expect(clashes.length, `${runId} should trip >=1 harmony_clash`).toBeGreaterThan(0);
      // chords_pad is the worst offender in all three runs (fixed 8-beat holds
      // over a moving 808 root) — pin it so a future prompt fix that actually
      // narrows the clash is visible as a real regression-of-the-fixture, not
      // just "still > 0".
      expect(clashes.some((p) => p.trackId === "1022")).toBe(true);
    }
  });

  it("every run is NOT ok (round 1 was a unanimous fail — produceCheck should agree)", () => {
    for (const runId of ["live3-sonnet", "live4-opus", "live5-sonnet"]) {
      expect(checkProduceRun(loadRunAsCheckInput(runId)).ok, runId).toBe(false);
    }
  });
});

describe("checkProduceRun on a hand-built clean input", () => {
  // D minor: chord on the root (D=62) is D-F-A(-C/C#); chord on F (root 65) is
  // F-A-C(-Eb natural minor vii, or Eb/E depending on form) — kept simple: every
  // melodic note below is a tone of whichever triad is diatonic to the sounding
  // 808 root, one clean voicing per half.
  function clean(): CheckInput {
    const tracks: Record<string, CheckNote[]> = {
      // 808: D (root) for beats 0-16, F for 16-32 — <=2 root changes total.
      "1014": [
        { pitch: 62, start: 0, length: 16, velocity: 100 },
        { pitch: 65, start: 16, length: 16, velocity: 100 },
      ],
      // drums: all 10 pads, covers 0-32, even A/B density.
      "1010": Array.from({ length: 64 }, (_, i) => ({
        pitch: PADS[i % PADS.length]!,
        start: i * 0.5,
        length: 0.25,
        velocity: 90 + (i % 20),
      })),
      // chords_pad: D-minor triad (D,F,A) while 808 holds D; F-major-ish (F,A,C)
      // while 808 holds F — re-voiced at beat 16, matching the 808 root change.
      "1022": [
        { pitch: 62, start: 0, length: 16, velocity: 80 },
        { pitch: 65, start: 0, length: 16, velocity: 78 },
        { pitch: 69, start: 0, length: 16, velocity: 76 },
        { pitch: 65, start: 16, length: 16, velocity: 80 },
        { pitch: 69, start: 16, length: 16, velocity: 78 },
        { pitch: 72, start: 16, length: 16, velocity: 76 },
      ],
      // lead: chord tones only, even spread across A/B.
      "1018": Array.from({ length: 16 }, (_, i) => ({
        pitch: i < 8 ? [62, 65, 69][i % 3]! + 12 : [65, 69, 72][i % 3]! + 12,
        start: i * 2,
        length: 1,
        velocity: 90,
      })),
      // counter, arp, stab: same idea, chord-tone only, present in both halves.
      "1030": Array.from({ length: 8 }, (_, i) => ({
        pitch: i < 4 ? [62, 65, 69][i % 3]! + 12 : [65, 69, 72][i % 3]! + 12,
        start: i * 4, length: 2, velocity: 90,
      })),
      "1034": Array.from({ length: 32 }, (_, i) => ({
        pitch: i < 16 ? [62, 65, 69][i % 3]! + 12 : [65, 69, 72][i % 3]! + 12,
        start: i, length: 0.5, velocity: 85,
      })),
      "1042": Array.from({ length: 8 }, (_, i) => ({
        pitch: i < 4 ? [62, 65, 69][i % 3]! + 12 : [65, 69, 72][i % 3]! + 12,
        start: i * 4, length: 1.5, velocity: 95,
      })),
      // drone, ambient: sparse, not judged for harmony; just needs to exist and reach past 28.
      "1026": [{ pitch: 50, start: 0, length: 16, velocity: 70 }, { pitch: 53, start: 16, length: 16, velocity: 70 }],
      "1038": [{ pitch: 86, start: 0, length: 16, velocity: 60 }, { pitch: 89, start: 16, length: 16, velocity: 60 }],
    };
    return { key: KEY, roles: ROLES, tracks, pads: PADS, bars: 8 };
  }

  it("passes — ok:true, no problems", () => {
    const report = checkProduceRun(clean());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a role with no notes trips missing_clip", () => {
    const input = clean();
    delete (input.tracks as Record<string, CheckNote[]>)["1042"];
    const report = checkProduceRun(input);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.code === "missing_clip" && p.trackId === "1042")).toBe(true);
  });

  it("a track that stops before beat 28 trips stops_early", () => {
    const input = clean();
    input.tracks["1018"] = input.tracks["1018"]!.filter((n) => n.start < 20);
    const report = checkProduceRun(input);
    expect(report.problems.some((p) => p.code === "stops_early" && p.trackId === "1018")).toBe(true);
  });

  it("a thin B half trips b_thin", () => {
    const input = clean();
    // A half keeps 8 notes, B half collapses to 1 — still spans past beat 28 via one note.
    input.tracks["1034"] = [
      ...input.tracks["1034"]!.filter((n) => n.start < 16).slice(0, 8),
      { pitch: 65, start: 30, length: 1, velocity: 80 },
    ];
    const report = checkProduceRun(input);
    expect(report.problems.some((p) => p.code === "b_thin" && p.trackId === "1034")).toBe(true);
  });

  it("fewer than 7 pads used trips few_pads", () => {
    const input = clean();
    input.tracks["1010"] = input.tracks["1010"]!.map((n) => ({ ...n, pitch: n.pitch % 2 === 0 ? 36 : 38 }));
    const report = checkProduceRun(input);
    expect(report.problems.some((p) => p.code === "few_pads")).toBe(true);
  });

  it("a chord tone outside the diatonic triad trips harmony_clash", () => {
    const input = clean();
    // Add two clearly non-diatonic (chromatic) notes per beat for beats 0-9 while
    // the 808 holds D — 20 clashing activations against the clean input's ~96
    // consonant ones is enough to clear the >15% trip threshold (a single sparse
    // clash would round-trip under it, which is correct: an occasional passing
    // tone shouldn't fail a whole track).
    input.tracks["1022"] = [
      ...input.tracks["1022"]!,
      ...Array.from({ length: 10 }, (_, i) => [
        { pitch: 63, start: i, length: 1, velocity: 80 }, // Eb — not in D minor's triad-on-D
        { pitch: 64, start: i, length: 1, velocity: 80 }, // E — not in D minor's triad-on-D
      ]).flat(),
    ];
    const report = checkProduceRun(input);
    const clash = report.problems.find((p) => p.code === "harmony_clash" && p.trackId === "1022");
    expect(clash).toBeDefined();
  });
});

describe("renderCheckAsRepairError", () => {
  it("ok report renders a short no-problems message", () => {
    const text = renderCheckAsRepairError({ ok: true, problems: [], summary: "fine" });
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toContain("no problems");
  });

  it("names trackIds and stays <= 1200 chars for a real failing run (opus, stops_early + clashes)", () => {
    const report = checkProduceRun(loadRunAsCheckInput("live4-opus"));
    const text = renderCheckAsRepairError(report);
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toContain("1010"); // the drums track that stopped early
    expect(text).toContain("PRODUCE CHECK FAILED");
  });

  it("truncates gracefully with many problems, still <= 1200 chars, still names at least one trackId", () => {
    const problems = Array.from({ length: 40 }, (_, i) => ({
      code: "harmony_clash" as const,
      trackId: String(1000 + i),
      detail: `track ${1000 + i} clashes with the 808 root on a long list of beats that pads out this detail string to make sure truncation is actually exercised by this test case ${"x".repeat(40)}`,
    }));
    const text = renderCheckAsRepairError({ ok: false, problems, summary: "many problems" });
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toMatch(/100\d/); // at least the first trackId survived
  });
});
