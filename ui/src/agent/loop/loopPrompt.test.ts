import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildLoopSystemPrompt, renderTaskContext, LOOP_RULES } from "./loopPrompt";
import { renderSession } from "../sessionRender";
import { systemPrompt } from "../brainCore";
import type { Snapshot } from "../../types";

const SNAP: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, key: { tonic: "A", mode: "minor" }, length: 16, editFile: "",
    tempoMap: [{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 200, curve: 0 }],
  },
  tracks: [
    { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: -2, pan: 0.2, mute: false, solo: false,
      sends: [{ bus: 1, db: -12 }],
      clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  // a real snapshot's master plugins always carry `type` + `builtin` (MoshOps
  // pluginToVar) — the chain renders the TYPE for builtins, since that is the
  // string load_master_builtin takes. See sessionRender.test.ts.
  master: { volumeDb: -3, pan: 0, plugins: [{ index: 0, name: "Compressor", type: "compressor", builtin: true, enabled: true }] },
  buses: [{ bus: 1, name: "Reverb", trackId: "9" }],
} as unknown as Snapshot;

describe("renderSession — the Phase-A visibility fix", () => {
  const block = renderSession(SNAP);

  it("shows the master fader (the −3dB default nobody could see), pan and chain", () => {
    expect(block).toContain("master: -3dB pan 0 chain:[compressor]");
  });

  it("shows the tempo map WITH the indices remove_tempo_change takes", () => {
    expect(block).toContain("tempo map (by index): [0] 120bpm@0s, [1] 200bpm@4s ramp");
  });

  it("shows the key, buses, per-track pan and sends", () => {
    expect(block).toContain("key: A minor");
    expect(block).toContain('buses: 1 "Reverb"');
    expect(block).toContain("pan 0.2");
    expect(block).toContain("sends:[bus1@-12dB]");
  });

  it("keeps the compact style's quoted ids (the string-id contract)", () => {
    expect(block).toContain('"17" "Drums"');
    expect(block).toContain('"101":midi@0s');
  });
});

describe("buildLoopSystemPrompt", () => {
  it("carries the multi-step contract, the catalog, the loop rules and the rich session", () => {
    const p = buildLoopSystemPrompt(SNAP);
    expect(p).toContain('"status": "continue" | "done" | "need_user"');
    expect(p).toContain("- set_tempo(bpm) — ");           // the catalog rendering
    expect(p).toContain(LOOP_RULES.split("\n")[1]!);       // plan-first rule
    expect(p).toContain("master: -3dB");
  });

  it("injects producer knowledge for the ask, like the single-shot path", () => {
    expect(buildLoopSystemPrompt(SNAP, "put a compressor on the master bus")).toContain("Producer knowledge");
    expect(buildLoopSystemPrompt(SNAP)).not.toContain("Producer knowledge");
  });
});

describe("buildLoopSystemPrompt: M2 memory param — byte-stability + the one-section diff", () => {
  it("omitting memory is byte-identical to the pre-M2 shape (2-arg and explicit-undefined 3rd arg)", () => {
    const twoArg = buildLoopSystemPrompt(SNAP);
    expect(buildLoopSystemPrompt(SNAP, undefined, undefined)).toBe(twoArg);
    expect(buildLoopSystemPrompt(SNAP, undefined, "")).toBe(twoArg);
    expect(twoArg).not.toContain("Memory —");
  });

  it("when memory IS provided, it's the only addition — everything else is untouched", () => {
    const memory = "Memory — a made-up section for this test.\n- (this project) a fact";
    const without = buildLoopSystemPrompt(SNAP);
    const withMemory = buildLoopSystemPrompt(SNAP, undefined, memory);

    const rulesFirstLine = LOOP_RULES.split("\n")[0]!;
    const beforeLines = without.split("\n");
    const afterLines = withMemory.split("\n");
    const memoryLines = memory.split("\n");
    const splitAt = beforeLines.indexOf(rulesFirstLine);
    expect(splitAt).toBeGreaterThan(-1);
    expect(afterLines.length).toBe(beforeLines.length + memoryLines.length);
    expect(afterLines.slice(0, splitAt)).toEqual(beforeLines.slice(0, splitAt));
    expect(afterLines.slice(splitAt, splitAt + memoryLines.length)).toEqual(memoryLines);
    expect(afterLines.slice(splitAt + memoryLines.length)).toEqual(beforeLines.slice(splitAt));
  });

  it("memory slots after knowledge and before the loop rules, same as the single-shot path", () => {
    const memory = "Memory — a made-up block.";
    // buildLoopSystemPrompt computes its own knowledge internally from `query`; use a
    // real query so a real knowledge block appears, then just check relative order.
    const p = buildLoopSystemPrompt(SNAP, "put a compressor on the master bus", memory);
    const knowIdx = p.indexOf("Producer knowledge");
    const memIdx = p.indexOf(memory);
    const rulesIdx = p.indexOf(LOOP_RULES.split("\n")[0]!);
    expect(knowIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeGreaterThan(knowIdx);
    expect(rulesIdx).toBeGreaterThan(memIdx);
  });
});

describe("renderTaskContext", () => {
  it("renders plan progress, verbatim step errors and the budget line", () => {
    const ctx = renderTaskContext({
      ask: "warp it",
      plan: [{ goal: "warp the clip" }, { goal: "check it" }],
      planIdx: 1,
      history: [{
        commands: [{ command: "set_clip_warp", args: {} }],
        results: [{ command: "set_clip_warp", ok: false, error: "not an audio clip" }],
        invalidCount: 0, ms: 5,
      }],
      stepsLeft: 7, repliesLeft: 9, mode: "repair",
    });
    expect(ctx).toContain("TASK: warp it");
    expect(ctx).toContain("✓ 1. warp the clip");
    expect(ctx).toContain("→ 2. check it");
    expect(ctx).toContain("ERROR: not an audio clip");
    expect(ctx).toContain("Budget: 7 step(s) and 9 replies left.");
    expect(ctx).toContain("never repeat a failed command unchanged");
  });
});

describe("legacy prompt byte-stability pin", () => {
  // The pin below moves whenever the prompt changes at all. THIS test says WHAT
  // the single-shot prompt must contain — the master line whose absence made
  // master-trim unsolvable single-shot, and the key it was also dropping.
  it("the shipped single-shot prompt SHOWS master state and the session key", () => {
    const fixture = {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [
        { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
          clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
      ],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    } as unknown as Snapshot;
    const p = systemPrompt(fixture);
    expect(p).toContain("master: 0dB pan 0 chain:[empty]");
    expect(p).toContain("key: C major");
    // and the compact renderer's contract still holds — quoted ids
    expect(p).toContain('"17" "Drums"');
    expect(p).toContain('"101":midi@0s');

    // The FULL rendered block for this fixture. Pinning the whole thing (not just
    // `toContain`) is what makes the pin comment's "exactly two added lines"
    // claim checkable: the old compact render was these same lines minus `key:`
    // and `master:`.
    expect(renderSession(fixture)).toBe(
      [
        "tempo 120 BPM, 4/4",
        "key: C major",
        "master: 0dB pan 0 chain:[empty]",
        "sections: (none)",
        "tracks:",
        '  "17" "Drums" 0dB clips:["101":midi@0s]',
      ].join("\n"),
    );
  });

  // The SHIPPED single-shot prompt (SFT/gepa/bench surface) must never move as
  // a side effect of loop work. An INTENTIONAL prompt change updates this hash
  // consciously — that is the point of the pin.
  it("systemPrompt(FIXTURE) hash is unchanged", () => {
    const fixture = {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [
        { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
          clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
      ],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    } as unknown as Snapshot;
    const hash = createHash("sha256").update(systemPrompt(fixture)).digest("hex");
    // Moved 2026-08-03 (b), consciously: the Drum Rack added set_drum_pad,
    // clear_drum_pad, apply_choke and list_drum_kits to the catalog (and a kit arg to
    // load_drum_kit), so the prompt gained two command lines. These are real new agent
    // capability (per-pad level/pan/name/choke, and the missing inverse of
    // assign_sample, which could only ever REPLACE a pad), not wording — the agent could
    // previously build a kit but never balance or empty one.
    //
    // Deliberately NOT included in that move: set_note's `mute` and `edits` args, which
    // the piano roll uses but the catalog does not declare. Widening an existing entry
    // for something the agent does not need is exactly the kind of drift this pin exists
    // to catch, so those stayed undeclared instead.
    //
    // This pin is the MERGE of that change with (a) below — the Drum Rack branch and the
    // builtin-vocabulary commit moved the pin independently, so neither side's recorded
    // hash survives. The catalog diff was re-read across the merge to confirm the union
    // is exactly those two sets of lines and nothing else.
    //
    // Prior move, 2026-08-03 (a): the builtin `type` VOCABULARY is now inline in the
    // catalog, because the bench proved the model had no other way to learn it. The
    // MoshAgentBench `master` category failed on every seat; the transcripts showed a
    // doubled `list_builtins, list_builtins` followed by a guessed type that the engine
    // rejected. The reason it is a dead end is structural, not a wording problem:
    // StepCommandResult is {command, ok, error} with NO payload, so the agentic loop
    // never shows the model what a read-only discovery call actually returned.
    // The specific killer was "eq" — the natural guess — where the engine's type is
    // "4bandEq" (the same drift bridge.mock.ts's header already records).
    //
    // Exactly three catalog lines moved vs the previous pin; the prompt's SHAPE is
    // unchanged (no new section, no reordering, session render untouched):
    //   list_builtins       — no longer advertised as the route to `type` names
    //   load_builtin        — + "type is EXACTLY one of: <13 names>" (the only real
    //                         token cost, ~40 tokens; sourced from BUILTIN_TYPES)
    //   load_master_builtin — + "same 'type' vocabulary as load_builtin", naming the
    //                         two the master tasks need (compressor / 4bandEq)
    //
    // Consumers to be aware of, since this pin is what ties them together: the SFT
    // corpora and GEPA baselines were built against the pre-builtins catalog text. They
    // are not invalidated (no command was added, removed or renamed — only three
    // descriptions changed), but a corpus rebuilt after this commit will carry the new
    // text. service/sft/build_add_note_corrective.py needs no edit: it PARSES
    // AGENT_COMMANDS out of commands.ts rather than hand-copying it. Its one hand-mirror,
    // render_session(), mirrors compactSnapshot — which this change does not touch.
    //
    // Prior move, 2026-07-28: the two session renderers were unified. The
    // single-shot path used to render via brainCore's compactSnapshot, which showed
    // NO master state — so a model asked to "pull the master down a couple dB" could
    // not see that the fader defaults to -3dB and guessed an absolute value that
    // graded as moving UP (MoshAgentBench master-trim: 0/10 single, 5/5 loop, same
    // models). Both paths now use ../sessionRender.ts. For THIS fixture the diff is
    // exactly two added lines — "key: C major" and "master: 0dB pan 0 chain:[empty]";
    // richer sessions also gain the tempo map, buses and per-track pan/sends. The
    // "exactly two added lines" claim is not just prose: the test above pins the
    // fixture's FULL rendered block.
    //
    // Previous pins (two lineages, merged at 2026-08-03 — neither branch tip's own hash
    // is reachable from here, which is why both are listed):
    // - drum-rack branch, pre-merge:  e699bb5c200d27200711dc36b008567cde58e380ad70efb3cff9d8e62743bb2e
    // - main, pre-merge (builtins):   a8113fe0e571e1e8180aab1e8fc699703e7f8d8da582561c12e1a7612044e37c
    // - pre-kit-library:              0396e079069da25afde5d96dcf0a9019bd6774b2e12d4c44840583d065ab1c39
    // - pre-apply-choke:              78e70a05732a178871f2a66292f7d5ab7f16be9d71fb3420d45147086e9fbde4
    // - pre-drum-rack / pre-builtins: e0917a62238b7dddb4cc09fcb44e3d9f02c4c121563661d97f614a8547a594e2
    // - pre-unified session renderer: 70f9a562bf8bf352f618c87d3be169c56a10d1c9c527b0bf9d2f84e446a1748e
    // - pre-musical-time contract:    a01b556e336db811631384a3030c340788899c00fc102b14b3062aa8ae2c7b83
    // The current pin still includes the shared beat-offset rule and the explicit
    // create_section/move_section catalog wording from issue #539.
    expect(hash).toBe("d3de1c58e515bd660c0b1214ee0db163a011de9c1326e66e450409587ba6e121");
  });

  // M2 extension: the pin above already proves the OMITTED-memory call is unmoved
  // (systemPrompt(fixture) never passes a 3rd arg). This makes that explicit and
  // proves the OPPOSITE isn't silently also true — the param genuinely threads
  // through when a caller DOES supply it, so "byte-identical when omitted" is a real
  // guarantee about the argument, not a dead/no-op parameter.
  it("the SAME fixture with an explicit memory arg produces a DIFFERENT hash (the param is live)", () => {
    const fixture = {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [
        { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
          clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
      ],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    } as unknown as Snapshot;
    const pinnedHash = createHash("sha256").update(systemPrompt(fixture)).digest("hex");
    const withMemoryHash = createHash("sha256")
      .update(systemPrompt(fixture, undefined, "Memory — a made-up section."))
      .digest("hex");
    expect(withMemoryHash).not.toBe(pinnedHash);
  });
});
