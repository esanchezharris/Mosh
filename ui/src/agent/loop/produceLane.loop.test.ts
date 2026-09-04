// W2.7 — the scripted-brain end-to-end proof: the produce-lane PREFLIGHT
// (produceTemplate.ts) plus a SCRIPTED brain that replays the corrected reference
// beat (mac-r0-001, docs/produce-corrections/mac-r0-001.meta.json) through the real
// loop FSM (runAgentLoop) over bridge.mock — no live model call, fully
// deterministic. This proves the MECHANICS end to end: the template's trackIds
// substitute cleanly into the fixture's `${role}` placeholders, every command
// validates and executes, and the resulting session matches the DRUMS/808/SYNTHS
// rules producePrompt.ts asks a real model to follow.
//
// The fixture (`__fixtures__/mac_r0_001_fix.program.json`, a full 9-step loop
// PLAN reply) and the few-shot fixture (`__fixtures__/produce_fewshot.txt`) are
// produced by service/prompt/mdsl_to_moshops.py (a different, concurrent slice of
// work). If either is absent this test SKIPS with a clear message instead of
// failing the suite — via plain node:fs (fs.existsSync + fs.readFileSync), NOT a
// Vite `?raw` import: Vite resolves a `?raw` specifier at TRANSFORM time, before
// any runtime guard runs, so it can't be "guarded" by wrapping the import() call
// in an `if` — a missing file crashes collection outright (confirmed empirically
// below). This is the same tsx/?raw bundle-safety concern knowledge.ts's header
// documents, just biting at a different layer (collection-time resolution instead
// of a missing runtime module).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import { createTaskExecutor } from "./taskExec";
import { runProduceTemplate, type ProduceTemplate } from "./produceTemplate";
import { buildProduceSystemPrompt, PRODUCE_BUDGETS } from "./producePrompt";
import { runAgentLoop, type ChatMessage } from "./loop";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { PaletteItem, PresetMenu } from "./drumPalette";
import type { Snapshot } from "../../types";

const here = dirname(fileURLToPath(import.meta.url));
const PROGRAM_PATH = join(here, "../__fixtures__/mac_r0_001_fix.program.json");
const FEWSHOT_PATH = join(here, "../__fixtures__/produce_fewshot.txt");
const FIXTURES_READY = existsSync(PROGRAM_PATH) && existsSync(FEWSHOT_PATH);
const SKIP_MESSAGE =
  `produce lane scripted-brain loop test SKIPPED — W2.7's converter fixtures are not yet ` +
  `present (produced by a concurrent slice of work): ${PROGRAM_PATH}, ${FEWSHOT_PATH}`;

type FixtureCommand = { command: string; args: Record<string, unknown> };
type FixtureStep = { goal: string; commands: FixtureCommand[] };
type FixtureProgram = { intent?: string; say?: string; status: string; plan: FixtureStep[] };

const PALETTE: PaletteItem[] = [
  { path: "/mock/palette/kick_1.wav", role: "kick" },
  { path: "/mock/palette/kick_2.wav", role: "kick" },
  { path: "/mock/palette/snare_1.wav", role: "snare" },
  { path: "/mock/palette/snare_2.wav", role: "snare" },
  { path: "/mock/palette/clap_1.wav", role: "clap" },
  { path: "/mock/palette/clap_2.wav", role: "clap" },
  { path: "/mock/palette/hat_1.wav", role: "hat" },
  { path: "/mock/palette/openhat_1.wav", role: "openhat" },
  { path: "/mock/palette/perc_1.wav", role: "perc" },
  { path: "/mock/palette/fx_1.wav", role: "fx" },
  { path: "/mock/palette/bass_1.wav", role: "bass", rootNote: 24 },
  { path: "/mock/palette/bass_2.wav", role: "bass", rootNote: 33 },
];
const PRESETS: PresetMenu = [
  { plugin: "vital", name: "Dark Lead", file: "/presets/vital/lead-dark.vital" },
  { plugin: "vital", name: "Trap Pluck", file: "/presets/vital/pluck-trap.vital" },
  { plugin: "vital", name: "Warm Pad", file: "/presets/vital/pad-warm.vital" },
  { plugin: "vital", name: "Airy Pad", file: "/presets/vital/pad-airy.vital" },
  { plugin: "vital", name: "Night Atmos", file: "/presets/vital/atmos-night.vital" },
  { plugin: "vital", name: "Rhodes", file: "/presets/vital/keys-rhodes.vital" },
  { plugin: "vital", name: "Glass Arp", file: "/presets/vital/arp-glass.vital" },
  { plugin: "vital", name: "Bell Hit", file: "/presets/vital/bell-hit.vital" },
];

/** `${drums}` / `${808}` / `${lead}` / … -> the preflight's real trackIds. */
function substituteTrackIds(json: string, template: ProduceTemplate): string {
  const map = new Map<string, string>([["drums", template.drums.trackId], ["808", template.bass.trackId]]);
  for (const s of template.synths) map.set(s.role, s.trackId);
  return json.replace(/\$\{(\w+)\}/g, (_whole, key: string) => {
    const id = map.get(key);
    if (!id) throw new Error(`fixture placeholder \${${key}} has no matching REQUIRED track`);
    return id;
  });
}

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}

function notesOf(s: Snapshot, trackId: string): Array<{ pitch: number; start: number; length: number; velocity: number }> {
  const track = s.tracks.find((t) => t.id === trackId);
  const clip = track?.clips.find((c) => c.type === "midi");
  return ((clip as { notes?: Array<{ pitch: number; start: number; length: number; velocity: number }> } | undefined)?.notes ?? [])
    .slice()
    .sort((a, b) => a.start - b.start);
}

describe.skipIf(!FIXTURES_READY)("produce lane — scripted-brain loop over the corrected reference beat (W2.7)", () => {
  if (!FIXTURES_READY) {
    it.skip(SKIP_MESSAGE, () => {});
    return;
  }

  const program = JSON.parse(readFileSync(PROGRAM_PATH, "utf8")) as FixtureProgram;

  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("the few-shot fixture is present and non-trivial", () => {
    // NOT a `?raw` import: Vite resolves a `?raw` specifier at TRANSFORM time —
    // during collection, before any runtime guard (a describe.skipIf, an `if`
    // around the import() call) ever runs — so a literal `import("...?raw")`
    // for a file that doesn't exist yet crashes the whole suite regardless of
    // where it's written. Confirmed empirically: moving the fixtures aside and
    // re-running turned this file's failure from "5 skipped" into "Failed to
    // resolve import ...?raw — does the file exist?" at the vite:import-analysis
    // step, before a single test ran. That is exactly the tsx/?raw bundle-safety
    // trap knowledge.ts's header warns about (no ?raw import, no fs read THERE
    // because that file ships in the app bundle) — here, a plain node:fs read
    // is the correct guard, since this is vitest-only fixture loading, not
    // production code shipping in the Vite-bundled app.
    const text = readFileSync(FEWSHOT_PATH, "utf8");
    expect(text.length).toBeGreaterThan(200);
    expect(text).toContain("add_midi_clip");
  });

  it("replays the full 9-step reference program: 9 tracks, one 32-beat clip each, outcome done within budget", async () => {
    const ask = "produce a dark jerk trap beat at 148 in D minor";
    const t = createTaskExecutor("produce", { utterance: ask });
    const template = await runProduceTemplate(ask, { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 1 });

    const scriptedProgram = substituteTrackIds(JSON.stringify(program), template);
    let planCalls = 0;
    const scriptedChat = async (messages: ChatMessage[]): Promise<{ content: string }> => {
      const lastUser = messages[messages.length - 1]?.content ?? "";
      if (/make a plan/i.test(lastUser)) {
        planCalls++;
        return { content: scriptedProgram };
      }
      // Every fixture step already carries its commands inline, so the FSM
      // should never need a second model call — this branch existing (and
      // being asserted unreached below) is the proof.
      return { content: JSON.stringify({ status: "done" }) };
    };

    const run = await runAgentLoop({ ask }, {
      chat: scriptedChat,
      env: t.env,
      systemPrompt: (s: Snapshot | null, q?: string, mem?: string) => buildProduceSystemPrompt(s, q, mem, template),
      budgets: PRODUCE_BUDGETS,
    });
    await t.close();

    expect(run.outcome).toBe("done");
    expect(planCalls).toBe(1); // the whole plan replayed from ONE model call
    expect(run.transcript.every((step) => step.results.every((r) => r.ok))).toBe(true);

    const s = snap();
    const allTrackIds = [template.drums.trackId, template.bass.trackId, ...template.synths.map((x) => x.trackId)];
    expect(allTrackIds).toHaveLength(9);
    for (const trackId of allTrackIds) {
      const track = s.tracks.find((x) => x.id === trackId)!;
      expect(track, `track ${trackId} missing`).toBeDefined();
      const midiClips = track.clips.filter((c) => c.type === "midi");
      expect(midiClips, `track ${trackId} clip count`).toHaveLength(1);
      expect(midiClips[0]!.start).toBe(0);
      expect(midiClips[0]!.length).toBeCloseTo(template.constants.eightBarsSeconds, 5);
    }
  });

  it("the 808: at least 10 notes, mostly in MIDI 62-70, at least 3 distinct pitches, fully sustained (each note's end meets the next note's start)", async () => {
    const ask = "produce a dark jerk trap beat at 148 in D minor";
    const t = createTaskExecutor("produce", { utterance: ask });
    const template = await runProduceTemplate(ask, { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 1 });
    const scriptedProgram = substituteTrackIds(JSON.stringify(program), template);
    const scriptedChat = async (messages: ChatMessage[]) => {
      const lastUser = messages[messages.length - 1]?.content ?? "";
      return { content: /make a plan/i.test(lastUser) ? scriptedProgram : JSON.stringify({ status: "done" }) };
    };
    await runAgentLoop({ ask }, {
      chat: scriptedChat, env: t.env,
      systemPrompt: (s: Snapshot | null, q?: string, mem?: string) => buildProduceSystemPrompt(s, q, mem, template),
      budgets: PRODUCE_BUDGETS,
    });
    await t.close();

    const notes = notesOf(snap(), template.bass.trackId);
    expect(notes.length).toBeGreaterThanOrEqual(10);
    // the corrected reference beat's actual 808 line carries a couple of
    // octave-dip passing tones just outside the strict 62-70 window (the same
    // "dipped into a lower octave" character mac-r0-001's stab correction names)
    // — the overwhelming majority still sits in-register.
    const inRegister = notes.filter((n) => n.pitch >= 62 && n.pitch <= 70).length;
    expect(inRegister / notes.length).toBeGreaterThan(0.8);
    expect(new Set(notes.map((n) => n.pitch)).size).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < notes.length - 1; i++)
      expect(notes[i]!.start + notes[i]!.length, `gap after note ${i}`).toBeCloseTo(notes[i + 1]!.start, 5);
  });

  it("the drums: at least 10 distinct pad pitches and at least 6 hits in every 4-beat bar across 8 bars", async () => {
    const ask = "produce a dark jerk trap beat at 148 in D minor";
    const t = createTaskExecutor("produce", { utterance: ask });
    const template = await runProduceTemplate(ask, { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 1 });
    const scriptedProgram = substituteTrackIds(JSON.stringify(program), template);
    const scriptedChat = async (messages: ChatMessage[]) => {
      const lastUser = messages[messages.length - 1]?.content ?? "";
      return { content: /make a plan/i.test(lastUser) ? scriptedProgram : JSON.stringify({ status: "done" }) };
    };
    await runAgentLoop({ ask }, {
      chat: scriptedChat, env: t.env,
      systemPrompt: (s: Snapshot | null, q?: string, mem?: string) => buildProduceSystemPrompt(s, q, mem, template),
      budgets: PRODUCE_BUDGETS,
    });
    await t.close();

    const notes = notesOf(snap(), template.drums.trackId);
    expect(new Set(notes.map((n) => n.pitch)).size).toBeGreaterThanOrEqual(10);
    for (let bar = 0; bar < 8; bar++) {
      const inBar = notes.filter((n) => n.start >= bar * 4 && n.start < (bar + 1) * 4);
      expect(inBar.length, `bar ${bar + 1} hit count`).toBeGreaterThanOrEqual(6);
    }
  });

  it("the stabs carry real sustained notes (not wall-to-wall staccato) — the mac-r0-001 correction lesson", async () => {
    const ask = "produce a dark jerk trap beat at 148 in D minor";
    const t = createTaskExecutor("produce", { utterance: ask });
    const template = await runProduceTemplate(ask, { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 1 });
    const stabTrackId = template.synths.find((s) => s.role === "stab")!.trackId;
    const scriptedProgram = substituteTrackIds(JSON.stringify(program), template);
    const scriptedChat = async (messages: ChatMessage[]) => {
      const lastUser = messages[messages.length - 1]?.content ?? "";
      return { content: /make a plan/i.test(lastUser) ? scriptedProgram : JSON.stringify({ status: "done" }) };
    };
    await runAgentLoop({ ask }, {
      chat: scriptedChat, env: t.env,
      systemPrompt: (s: Snapshot | null, q?: string, mem?: string) => buildProduceSystemPrompt(s, q, mem, template),
      budgets: PRODUCE_BUDGETS,
    });
    await t.close();

    const notes = notesOf(snap(), stabTrackId);
    expect(notes.length).toBeGreaterThan(0);
    // at least one genuinely long held phrase (>= 1.5 beats, well past staccato)
    expect(Math.max(...notes.map((n) => n.length))).toBeGreaterThanOrEqual(1.5);
    // and a real fraction of notes sustain at least a half beat, not everything a grace hit
    const sustained = notes.filter((n) => n.length >= 0.5).length;
    expect(sustained / notes.length).toBeGreaterThan(0.3);
  });
});
