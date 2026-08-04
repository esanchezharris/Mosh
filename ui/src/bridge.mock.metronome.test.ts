// CAP-TRN-005 — the dev-mock's set_metronome, which is what EVERY Playwright spec runs
// against. The mock is the one seam the native --selftest cannot see and the component
// tests do not reach: a spec can only be as honest as the backend it talks to, and a mock
// that accepted a level of 50 (or turned the click off on a patch that never mentioned it)
// would make a green e2e run mean nothing.
//
// So this pins mock ⇄ backend PARITY on the three things cmdSetMetronome does that a naive
// mock would get wrong: partial-patch semantics, the engine's level clamp, and the routing
// sentinel. Where the mock genuinely cannot match — it has no filesystem, so it can check a
// sound path's extension but not its existence — that is said out loud rather than faked.

import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { ClickSettings, CommandResult, Snapshot } from "./types";

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

const click = async (): Promise<ClickSettings> =>
  (await mockSnapshot<Snapshot>()).session.click!;

describe("bridge mock set_metronome parity", () => {
  beforeEach(() => __resetMockForTests());

  it("seeds the same defaults MoshOps::clickSettingsToVar returns for a fresh project", async () => {
    const c = await click();
    // Not arbitrary: 0.6 is tracktion's SettingID::lastClickTrackLevel default, [0.2, 1.0]
    // is Edit::getClickTrackVolume's jlimit, 37/76 are its bigclick/littleclick notes.
    expect(c).toMatchObject({
      enabled: false, level: 0.6, levelMin: 0.2, levelMax: 1,
      emphasizeBars: false, recordingOnly: false,
      outputDevice: "", soundBig: "", soundSmall: "",
      midiNoteBig: 37, midiNoteSmall: 76,
    });
  });

  it("is a PARTIAL PATCH — a level-only call does not turn the click off", async () => {
    // The regression this exists for: `enabled` used to be the only arg and defaulted to
    // false, so any other field would have muted the click. Invisible in a screenshot.
    expect((await exec("set_metronome", { enabled: true })).ok).toBe(true);
    expect((await exec("set_metronome", { level: 0.8 })).ok).toBe(true);
    const c = await click();
    expect(c.enabled).toBe(true);
    expect(c.level).toBe(0.8);
    // …and the flat mirror the rest of the UI reads stays in step with the block.
    expect((await mockSnapshot<Snapshot>()).session.metronome).toBe(true);
  });

  it("refuses a call that names nothing it understands, instead of silently muting", async () => {
    expect((await exec("set_metronome", { enabled: true })).ok).toBe(true);
    const empty = await exec("set_metronome", {});
    const junk = await exec("set_metronome", { nonsense: 1 });
    expect(empty.ok).toBe(false);
    expect(junk.ok).toBe(false);
    expect((await click()).enabled).toBe(true);
  });

  it("clamps the level to the engine's floor, so 0 is a quiet click and not silence", async () => {
    expect((await exec("set_metronome", { level: 0 })).ok).toBe(true);
    expect((await click()).level).toBe(0.2);
    expect((await exec("set_metronome", { level: 1.5 })).ok).toBe(false);
    expect((await exec("set_metronome", { level: -0.1 })).ok).toBe(false);
    expect((await click()).level).toBe(0.2);   // a refusal left storage alone
  });

  it("resolves the routing sentinels the way the engine does", async () => {
    expect((await exec("set_metronome", { outputDevice: "External Headphones" })).ok).toBe(true);
    expect((await click()).outputDevice).toBe("External Headphones");
    for (const sentinel of ["", "default"]) {
      expect((await exec("set_metronome", { outputDevice: sentinel })).ok).toBe(true);
      // "(default audio output)" is a routing VALUE findOutputDeviceWithName matches, not
      // a label — spelling it differently here would break the round-trip silently.
      expect((await click()).outputDevice).toBe("(default audio output)");
    }
  });

  it("bounds the MIDI click notes", async () => {
    expect((await exec("set_metronome", { midiNoteBig: 60 })).ok).toBe(true);
    expect((await click()).midiNoteBig).toBe(60);
    expect((await exec("set_metronome", { midiNoteBig: 128 })).ok).toBe(false);
    expect((await exec("set_metronome", { midiNoteSmall: -1 })).ok).toBe(false);
    expect((await click()).midiNoteBig).toBe(60);
  });

  it("rejects a non-WAV click sound — and can only check the half it has", async () => {
    expect((await exec("set_metronome", { soundBig: "/x/click.aiff" })).ok).toBe(false);
    expect((await exec("set_metronome", { soundBig: "/x/click.wav" })).ok).toBe(true);
    expect((await click()).soundBig).toBe("/x/click.wav");
    // ↑ accepted despite not existing: the mock has no filesystem. The BACKEND refuses a
    // missing path (--selftest covers it), so this asymmetry is a known mock ceiling, not
    // a contract difference to build on.
    expect((await exec("set_metronome", { soundBig: "" })).ok).toBe(true);
    expect((await click()).soundBig).toBe("");
  });

  it("pushes NO undo step, because the real command takes no transaction", async () => {
    // Every CLICKTRACK CachedValue is bound with a nullptr UndoManager in the engine, so
    // cmdSetMetronome pushes nothing on the undo stack. The mock used to pushUndo() here,
    // and the consequence was concrete: an undo after a click change would have eaten the
    // click change and LEFT the arrangement edit before it — the opposite of the app.
    expect((await exec("create_track", { name: "UndoAnchor" })).ok).toBe(true);
    expect((await exec("set_metronome", { level: 0.9, enabled: true })).ok).toBe(true);
    expect((await click()).level).toBe(0.9);
    expect((await exec("undo")).ok).toBe(true);

    // The one undo step in play is create_track's, so that is what comes back off it.
    const after = await mockSnapshot<Snapshot>();
    expect(after.tracks.some((t) => t.name === "UndoAnchor")).toBe(false);

    // MOCK CEILING, said out loud so nobody builds on it: the mock's undo is a
    // whole-snapshot rollback, so it also reverts the click level here. The real app does
    // not — Tracktion's undo pops the create_track transaction and never touches the
    // CLICKTRACK child. Only `--selftest` can prove that half (it does: "undo after
    // set_metronome does NOT revert it"). What IS provable here is the step count above.
    expect(after.session.click!.level).toBe(0.6);
  });

  it("offers click destinations by NAME, spanning wave and MIDI outs", async () => {
    const r = await exec("list_audio_devices");
    const outs = (r.data as { clickOutputs?: { name: string; isMidi: boolean }[] }).clickOutputs!;
    expect(outs[0]).toEqual({ name: "(default audio output)", isMidi: false });
    expect(outs.some((o) => o.isMidi)).toBe(true);     // the MIDI-note reveal needs one
    expect(outs.every((o) => typeof o.name === "string" && o.name !== "")).toBe(true);
  });
});
