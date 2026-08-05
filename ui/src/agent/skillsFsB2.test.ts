// Behavioural coverage for the five FS-B2 workflow skills (2026-07-28).
//
// WHY A SEPARATE FILE: the existing suite gives every SKILL_CATALOG entry STATIC
// coverage — commands.contract.test.ts walks each template against the real command
// surface, skills.test.ts exercises the slot validator catalog-wide. Neither runs a
// skill's `precondition`/`postcondition`, and skillHarness.test.ts names no catalog
// skill at all (it drives its own fixtures through SET_TRACK_LEVEL_SKILL).
//
// So the predicates below — refuse converting a track that holds audio, refuse a
// nonexistent bus, refuse recording while already recording, refuse paramIndex without
// value — had ZERO tests when they were written. Untested predicate logic inside a skill
// the agent executes is precisely this repo's recurring failure mode: it looks identical
// to tested logic right up until it silently allows something destructive.
//
// These are pure functions of (snapshot, slots), so they need no harness and no mock
// backend — call them directly and assert on the refusal REASON, not just `ok`.

import { describe, expect, it } from "vitest";
import {
  ADD_BUILTIN_EFFECT_SKILL,
  KEEP_LAST_TAKE_SKILL,
  PREPARE_DRUM_TRACK_SKILL,
  RECORD_TAKE_SKILL,
  SEND_TO_BUS_SKILL,
  type SkillCheck,
} from "./skills";
import type { Snapshot } from "../types";

const reason = (check: SkillCheck): string => (check.ok ? "" : check.reason);

/** A minimal snapshot with the fields these five skills actually read. Deliberately
 *  hand-built rather than imported from a shared fixture: a shared fixture that grows a
 *  field silently changes what these assertions mean. */
function snapshotWith(over: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120 },
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    tracks: [
      { id: "t1", index: 0, name: "Drums", type: "audio", clips: [], plugins: [] },
      { id: "t2", index: 1, name: "Vox", type: "audio", plugins: [], clips: [{ id: "c1", type: "wave", start: 0, length: 4 }] },
    ],
    buses: [{ bus: 0, name: "Reverb", trackId: "b0" }],
    ...over,
  } as unknown as Snapshot;
}

describe("prepare_drum_track", () => {
  it("converts a bare track", () => {
    expect(PREPARE_DRUM_TRACK_SKILL.precondition(snapshotWith(), { trackId: "t1" }).ok).toBe(true);
  });

  it("REFUSES a track holding audio — converting it would discard the audio", () => {
    const check = PREPARE_DRUM_TRACK_SKILL.precondition(snapshotWith(), { trackId: "t2" });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/discard/i);
  });

  it("refuses a track that does not exist", () => {
    expect(PREPARE_DRUM_TRACK_SKILL.precondition(snapshotWith(), { trackId: "nope" }).ok).toBe(false);
  });

  it("postcondition fails when the track did not actually become a drum track", () => {
    const after = snapshotWith();   // t1 is still type "audio"
    expect(PREPARE_DRUM_TRACK_SKILL.postcondition(snapshotWith(), after, { trackId: "t1" }, { applied: 2, entries: [] }).ok)
      .toBe(false);
  });
});

describe("send_to_bus", () => {
  it("sends to an existing bus", () => {
    expect(SEND_TO_BUS_SKILL.precondition(snapshotWith(), { trackId: "t1", bus: 0, db: -6 }).ok).toBe(true);
  });

  it("REFUSES a bus that does not exist, and says why it cannot just create one", () => {
    const check = SEND_TO_BUS_SKILL.precondition(snapshotWith(), { trackId: "t1", bus: 7, db: -6 });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/does not exist/i);
  });

  it("REFUSES sending a bus to a bus (feedback)", () => {
    const snap = snapshotWith({
      tracks: [{ id: "b0", index: 0, name: "Reverb", type: "audio", clips: [], plugins: [] }],
    } as Partial<Snapshot>);
    const check = SEND_TO_BUS_SKILL.precondition(snap, { trackId: "b0", bus: 0, db: -6 });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/feed back/i);
  });

  it("postcondition fails when the send did not land at the requested level", () => {
    const after = snapshotWith({
      tracks: [{ id: "t1", index: 0, name: "Drums", type: "audio", clips: [], plugins: [], sends: [{ bus: 0, db: -20 }] }],
    } as unknown as Partial<Snapshot>);
    const check = SEND_TO_BUS_SKILL.postcondition(snapshotWith(), after, { trackId: "t1", bus: 0, db: -6 }, { applied: 2, entries: [] });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/-20 dB, not -6 dB/);
  });
});

describe("record_take", () => {
  it("arms and rolls on an idle transport", () => {
    expect(RECORD_TAKE_SKILL.precondition(snapshotWith(), { trackId: "t1" }).ok).toBe(true);
  });

  it("REFUSES to start a take while already recording", () => {
    const snap = snapshotWith({
      transport: { playing: true, recording: true, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    } as Partial<Snapshot>);
    const check = RECORD_TAKE_SKILL.precondition(snap, { trackId: "t1" });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/already recording/i);
  });

  it("postcondition fails when the transport never entered record", () => {
    expect(RECORD_TAKE_SKILL.postcondition(snapshotWith(), snapshotWith(), { trackId: "t1" }, { applied: 2, entries: [] }).ok)
      .toBe(false);
  });
});

describe("keep_last_take", () => {
  it("keeps a take on a clip that exists", () => {
    expect(KEEP_LAST_TAKE_SKILL.precondition(snapshotWith(), { clipId: "c1" }).ok).toBe(true);
  });

  it("refuses a clip that does not exist", () => {
    expect(KEEP_LAST_TAKE_SKILL.precondition(snapshotWith(), { clipId: "gone" }).ok).toBe(false);
  });

  it("postcondition fails when the transport is still recording", () => {
    const after = snapshotWith({
      transport: { playing: true, recording: true, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    } as Partial<Snapshot>);
    const check = KEEP_LAST_TAKE_SKILL.postcondition(snapshotWith(), after, { clipId: "c1" }, { applied: 2, entries: [] });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/still recording/i);
  });
});

describe("add_builtin_effect", () => {
  const slots = { trackId: "t1", type: "reverb", index: 0 };

  it("adds an effect at the head of an empty chain", () => {
    expect(ADD_BUILTIN_EFFECT_SKILL.precondition(snapshotWith(), slots).ok).toBe(true);
  });

  it("REFUSES paramIndex without value", () => {
    const check = ADD_BUILTIN_EFFECT_SKILL.precondition(snapshotWith(), { ...slots, paramIndex: 2 });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/without a value/i);
  });

  it("REFUSES value without paramIndex", () => {
    const check = ADD_BUILTIN_EFFECT_SKILL.precondition(snapshotWith(), { ...slots, value: 0.5 });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/without a paramIndex/i);
  });

  it("REFUSES a chain position past the end of the chain", () => {
    const check = ADD_BUILTIN_EFFECT_SKILL.precondition(snapshotWith(), { ...slots, index: 5 });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/past the end/i);
  });

  it("postcondition fails when no plugin was actually added", () => {
    const check = ADD_BUILTIN_EFFECT_SKILL.postcondition(snapshotWith(), snapshotWith(), slots, { applied: 1, entries: [] });
    expect(check.ok).toBe(false);
    expect(reason(check)).toMatch(/expected one more/i);
  });
});
