// TRK-KIND — the shipped (v2) shell could only ever create AUDIO tracks. Both add-track
// call sites in TrackLaneList were hardcoded to `create_track {name:"Audio"}`, and
// `add_midi_clip` had no v2 call site at all (only classic's Topbar did), so a mouse-only
// user could not program a beat or a melody in the default UI — the single biggest thing
// standing between this app and "finish a track in it". The backends were complete and
// Catch2-tested the whole time; nothing asked for them.
//
// These specs run against the REAL dev-mock backend (bridge.mock) — the same one
// store.exec routes through outside the JUCE WebView — so they prove the tracks land
// PLAYABLE (carrying the instrument that makes them audible), not merely that the right
// command strings were emitted. A drum or MIDI track without an instrument is silent, which
// is the failure mode that would otherwise pass a string-matching test.

import { beforeEach, describe, expect, it } from "vitest";
import { addTrackOfKind, TRACK_KINDS } from "./TrackLaneList";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { CommandResult } from "../../types";

type Exec = (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;

describe("v2 add-track — every offered kind is reachable and lands playable (TRK-KIND)", () => {
  let calls: { command: string; args?: Record<string, unknown> }[];
  let exec: Exec;

  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    calls = [];
    const real = useStore.getState().exec;
    exec = async (command, args) => {
      calls.push({ command, args });
      return real(command, args);
    };
  });

  // The mock signals `snapshot_invalidated` and the store re-reads on the event rail, so
  // store.snapshot is still the PRE-command value the instant exec() resolves. Drain the
  // event, then pull the fresh snapshot, before asserting on engine state.
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await useStore.getState().refresh();
  };
  const snap = () => useStore.getState().snapshot!;
  const newest = () => snap().tracks[snap().tracks.length - 1];
  const hasInstrument = (t: { plugins?: { isInstrument?: boolean }[] }) =>
    (t.plugins ?? []).some((p) => p.isInstrument);

  it("audio → a single create_track, no type forced", async () => {
    const before = snap().tracks.length;
    await addTrackOfKind("audio", exec);
    await settle();
    expect(calls.map((c) => c.command)).toEqual(["create_track"]);
    expect(calls[0].args).toEqual({ name: "Audio" });
    expect(snap().tracks.length).toBe(before + 1);
  });

  it("drums → a drum-typed track carrying the sampler+kit (else the beat is silent)", async () => {
    await addTrackOfKind("drum", exec);
    await settle();
    expect(calls.map((c) => c.command)).toEqual(["create_track"]);
    expect(calls[0].args).toEqual({ name: "Drums", type: "drum" });
    const t = newest();
    expect(t.type).toBe("drum");
    expect(hasInstrument(t)).toBe(true);
  });

  it("instrument → a synth-bearing track AND an empty MIDI clip to open in the piano roll", async () => {
    await addTrackOfKind("midi", exec);
    await settle();
    expect(calls.map((c) => c.command)).toEqual(["create_track", "add_midi_clip"]);
    const t = newest();
    // The clip must be addressed to the track we just made — not to tracks[0], which is
    // what an omitted trackId resolves to in the mock (and to a brand-new track natively).
    expect(calls[1].args).toEqual({ trackId: t.id });
    expect(hasInstrument(t)).toBe(true); // 4OSC, via add_midi_clip's default-instrument policy
    expect(t.clips.length).toBe(1);
    expect(t.clips[0].type).toBe("midi");
  });

  it("test tone → an audio track with a tone clip already on it", async () => {
    // add_test_tone_clip existed only in the classic Topbar, targeting the selected track.
    // v2 has no "add a clip to this track" affordance to hang it off, so it arrives the way
    // an Instrument track does: make the track, then put the clip on it.
    await addTrackOfKind("tone", exec);
    await settle();
    expect(calls.map((c) => c.command)).toEqual(["create_track", "add_test_tone_clip"]);
    const t = newest();
    expect(calls[1].args).toEqual({ trackId: t.id });
    expect(t.clips.length).toBe(1);
  });

  it("recipe beat → one generate_beat_recipe call whose generated program lands a playable track", async () => {
    // Unlike its siblings this entry creates no track itself — the recipe's generated
    // program does (one undoable batch natively; the mock applies a fixed tiny program).
    const before = snap().tracks.length;
    await addTrackOfKind("recipe", exec);
    await settle();
    expect(calls.map((c) => c.command)).toEqual(["generate_beat_recipe"]);
    expect(snap().tracks.length).toBe(before + 1);
    const t = newest();
    expect(hasInstrument(t)).toBe(true); // the recipe binds real sounds, never a silent track
    expect(t.clips.length).toBeGreaterThan(0);
  });

  it("never orphans a tone clip when create_track fails", async () => {
    const seen: string[] = [];
    await addTrackOfKind("tone", async (command) => {
      seen.push(command);
      return { ok: false, command, error: "boom" };
    });
    expect(seen).toEqual(["create_track"]);
  });

  it("never orphans a MIDI clip onto the wrong track when create_track fails", async () => {
    const seen: string[] = [];
    await addTrackOfKind("midi", async (command) => {
      seen.push(command);
      return { ok: false, command, error: "boom" };
    });
    // add_midi_clip must NOT follow a failed create — natively it would auto-create an
    // unnamed track, and in the mock it would land the clip on tracks[0].
    expect(seen).toEqual(["create_track"]);
  });

  it("every kind the menu offers actually creates a track (no silent fall-through)", async () => {
    for (const { kind, label } of TRACK_KINDS) {
      __resetMockForTests();
      await useStore.getState().refresh();
      const real = useStore.getState().exec;
      const before = useStore.getState().snapshot!.tracks.length;
      const seen: string[] = [];
      await addTrackOfKind(kind, async (command, args) => {
        seen.push(command);
        return real(command, args);
      });
      await settle();
      expect(seen.length, `"${label}" (${kind}) dispatched no command`).toBeGreaterThan(0);
      expect(
        useStore.getState().snapshot!.tracks.length,
        `"${label}" (${kind}) created no track`,
      ).toBe(before + 1);
    }
  });
});
