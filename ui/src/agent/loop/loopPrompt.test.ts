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
    // Moved 2026-08-03 (d), consciously: ONE catalog line REWORDED, set_metronome
    // (CAP-TRN-005). No command was added, removed or renamed; the prompt's SHAPE is
    // unchanged. The line gained three optional args — level, emphasizeBars,
    // recordingOnly — and `enabled` became optional, because the command turned into a
    // partial patch. That last part is the behavioural half of the move and the reason
    // it is worth the tokens: `enabled` used to default to FALSE, so a call that named
    // any other field would have silently muted the click.
    //
    // Deliberately NOT in that move: outputDevice, soundBig, soundSmall, midiNoteBig and
    // midiNoteSmall, which the same command also accepts. They take device names and WAV
    // paths that only the producer's own machine knows, and — the structural reason,
    // same as the builtin-vocabulary case below — StepCommandResult carries no payload,
    // so the loop can never show the model what list_audio_devices returned. Declaring
    // them would buy invented paths at real prompt cost. They are reachable by mouse in
    // the v2 metronome panel, and the exclusion is written down in commands.ts.
    //
    // Prior move, 2026-08-03 (c): ONE catalog line, set_record_options — how a
    // live take behaves (overdub vs a fresh clip, record-quantise, punch). It is in the
    // catalog rather than UI-only for consistency with set_count_in, which is already
    // there: both answer "what happens when I hit record", and a producer who can ask
    // for a two-bar count-in should be able to ask to record in overdub.
    //
    // capture_midi, which landed in the same commit, is deliberately NOT here. It keeps
    // what the producer just PLAYED, and the model has no performance sitting in the
    // retrospective buffer — an entry for it would cost prompt budget to advertise a
    // command that can only ever come back empty-handed. It lives in
    // commandClassification.ts instead, with that reason written down.
    //
    // Prior move, 2026-08-03 (b): the Drum Rack added set_drum_pad,
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
    // Moved 2026-08-03 — loop-region + play-start-offset args declared.
    //   set_transport — + N("loopStart") + N("loopEnd"), and the desc gains ", and the
    //                    loop region". cmdSetTransport has ALWAYS read both
    //                    (MoshOps.TempoProject.cpp:82-84) and only sets the range when
    //                    BOTH are present, but neither was declared — so the agent could
    //                    switch looping on and had no way to say WHERE. "loop the first
    //                    4 bars" was unreachable. Found by the new arg-type scan, which
    //                    also reports args a call site passes that the catalog never
    //                    declares (the UI has always sent these:
    //                    v2/timeline/TimeRangeBand.tsx:60, menuActions.ts:314).
    //   trim_clip     — + N("offset"), likewise read by cmdTrimClip and sent by
    //                    ui/clipDrag.ts:58 but undeclared. It is the play-start offset
    //                    into the source — the one thing separating "trim the clip" from
    //                    "slide the audio inside it".
    //
    // Same consumer posture as the builtins move above: NO command was added, removed or
    // renamed — two commands gained optional args and one desc changed — so the SFT
    // corpora and GEPA baselines are not invalidated, though a corpus rebuilt after this
    // commit carries the new text. build_add_note_corrective.py parses AGENT_COMMANDS out
    // of commands.ts, so it needs no edit.
    //
    // Moved 2026-08-03 (second time today) — `set_track_color` added to the catalog.
    //   set_track_color — the usability programme's first genuinely NEW command rather than
    //                     a UI for something the engine already had. Track colour is pure
    //                     organisation (it changes nothing audible), which is exactly why a
    //                     beat-first producer staring at a dozen lanes wants it. Args
    //                     {trackId, color:"#rrggbb"|""}; "" clears to the type default.
    //
    // This one DOES add a command, so unlike the loop-region move above it is a real
    // catalog growth: an SFT corpus or GEPA baseline rebuilt after this commit carries a
    // command the older ones never saw. Not invalidating (nothing was removed or renamed),
    // but worth knowing before comparing runs across this line.
    //
    //   move_track      — added with set_track_color as the second half of #550. Reordering
    //                     is arrangement state only; it refuses a track inside a group
    //                     rather than silently reparenting it (which would change routing,
    //                     i.e. sound, from a command that promises only to change order).
    //
    //
    // Previous pins. TWO LINEAGES, merged here: this branch (the usability programme)
    // and main (drum rack + MIDI editing) each grew the catalog independently, so
    // NEITHER side's pin was correct after the merge — the hash below was recomputed,
    // not picked. Both ancestries are listed because neither tip is reachable from here.
    // - pre-move-track: 6ad2eb8b3f352b88fbf89375dfe1b52b23aaac981b2d6dc7ddf18111d868ab5d
    // - pre-set-track-color: 28ba3c381e0891c0777678d2cbe7634e9bfe5d7bc1b4bc80d53dfa20e44a0721
    // - pre-loop-region-args: a8113fe0e571e1e8180aab1e8fc699703e7f8d8da582561c12e1a7612044e37c
    // - pre-builtins-vocabulary (unified renderer + issue #539 wording): e0917a62238b7dddb4cc09fcb44e3d9f02c4c121563661d97f614a8547a594e2
    //
    // Moved 2026-08-03 — `set_track_icon` added to the catalog (CAP-TRK-002 / #613).
    //   set_track_icon — the last unbuilt piece of #550. A track icon changes nothing
    //                    audible; it exists so a producer six tracks into a beat finds
    //                    the drums by shape before they read a name. Args
    //                    {trackId, icon}; icon is one of ten NAMES (drum, perc, bass,
    //                    guitar, keys, synth, vocal, strings, fx, sample) or "" to clear
    //                    back to the track type's default.
    //
    // Unlike the renderer moves above, this one ADDS a command, so it is real catalog
    // growth: an SFT corpus or GEPA baseline rebuilt after this commit carries a command
    // older ones never saw. Nothing was removed or renamed, so prior corpora are not
    // invalidated — but a run compared across this line is not comparing like with like.
    //
    // Previous pins (two lineages, merged at 2026-08-03 — neither branch tip's own hash
    // is reachable from here, which is why both are listed):
    // - pre-set-track-icon:           38abcf77a1ee222dd1b60cccb2a5e0791ef79d2c8fa0f3e0b816fec865f81334
    // - pre-record-options:           d3de1c58e515bd660c0b1214ee0db163a011de9c1326e66e450409587ba6e121
    // - drum-rack branch, pre-merge:  e699bb5c200d27200711dc36b008567cde58e380ad70efb3cff9d8e62743bb2e
    // - pre-kit-library:              0396e079069da25afde5d96dcf0a9019bd6774b2e12d4c44840583d065ab1c39
    // - pre-apply-choke:              78e70a05732a178871f2a66292f7d5ab7f16be9d71fb3420d45147086e9fbde4
    // - pre-unified session renderer: 70f9a562bf8bf352f618c87d3be169c56a10d1c9c527b0bf9d2f84e446a1748e
    // - pre-musical-time contract:    a01b556e336db811631384a3030c340788899c00fc102b14b3062aa8ae2c7b83
    // Latest move, CAP-CLP-017 (insert_time + move_clip ripple). Unlike the builtins
    // move above, this one ADDS A COMMAND, so say so plainly rather than filing it as a
    // wording tweak: the catalog gains `insert_time` (one line) and `move_clip` gains a
    // `ripple` arg plus the clause describing it. Two catalog lines differ, the prompt's
    // SHAPE is unchanged (no new section, no reordering, session render untouched).
    //
    // Consumer impact is therefore larger than the last pin's: an SFT corpus or GEPA
    // baseline built before this commit describes a catalog that is missing a command the
    // engine now answers to. Nothing is invalidated — no command was removed or renamed,
    // and every previously-gold completion is still valid — but a model trained on the
    // old text will never reach for insert_time, which is a coverage gap rather than a
    // correctness one. build_add_note_corrective.py needs no edit (it parses
    // AGENT_COMMANDS out of commands.ts rather than hand-copying it).
    //
    // The current pin still includes the shared beat-offset rule and the explicit
    // create_section/move_section catalog wording from issue #539.
    // - pre-insert-time (CAP-CLP-017): 38abcf77a1ee222dd1b60cccb2a5e0791ef79d2c8fa0f3e0b816fec865f81334
    // - main @ the usability-audit merge (#607):
    //                                 2ee994e58085baafc5ae47f16391e57b635a641cd23a7cdeb306e5a6983f10d2
    // - this branch, pre-rebase:      2674395a8f21029a694b2df9cccf5235a9d10eba6b0d86f50f6822e6fed91dc1
    // - main @ set_track_icon (#620): b06ddb381b43a5bd89441607733dcec69a73f49b3b5f3581e9dfe97d706ac912
    // This pin moved TWICE during one merge campaign — the catalog grew under this branch
    // first with set_track_color + move_track (#607), then with set_track_icon (#620). Each
    // time the pin was RECOMPUTED from the merged catalog rather than picked from a side,
    // which is the only correct move when both sides added commands.
    //
    // Moved again 2026-08-04, CAP-TRN-005 (`set_metronome` — level, sound, route). Third
    // time in the same campaign, and the same rule applied: main had meanwhile grown
    // `insert_time` + `move_clip.ripple` (CAP-CLP-017) and `jump_to_history` (CAP-PRJ-005),
    // while this branch grew `set_metronome`. NEITHER side's pin described the merged
    // catalog, so the hash below was RECOMPUTED from it — this branch's own
    // bac517c6… was as wrong post-rebase as main's f7e286ee… was.
    //
    // Both pre-merge tips are recorded because neither is reachable from here:
    // - pre-metronome-settings (this branch's base, same commit as pre-insert-time):
    //                                 38abcf77a1ee222dd1b60cccb2a5e0791ef79d2c8fa0f3e0b816fec865f81334
    // - this branch, pre-rebase:      bac517c6717a31d122a8d04ae49cf29da3d8387635b35c963aed70b23092a481
    // - main @ jump_to_history (#617), pin UNMOVED by that PR:
    //                                 f7e286eed2c29f157ae93bebbc3927e112a97f0d990d1238335742b40767ea46
    //
    // The current pin still includes the shared beat-offset rule and the explicit
    // create_section/move_section catalog wording from issue #539.
    expect(hash).toBe("3cbf58897a767ede9e5a1b699bb8a5d35f18124f86c11a9c0c112db130d25a3b");
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
