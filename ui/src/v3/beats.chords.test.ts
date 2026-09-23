import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { barSeconds, meterFrom } from "../time";
import { CHORD_PROGRESSION, dropChords } from "./beats";
import { useV3 } from "./shellState";
import type { CommandResult } from "../types";

// A20 — "+ Chords": a Keys track with a four-bar, four-chord progression in ONE undo step,
// the Keys preset loaded best effort, the new track selected and the Presets tab open.

const st = () => useStore.getState();
type Call = { command: string; args?: Record<string, unknown> };

describe("dropChords against the mock backend", () => {
  const originalExec = useStore.getState().exec;
  let calls: Call[];
  let override: ((c: string, a?: Record<string, unknown>) => CommandResult | null) | null;

  beforeEach(async () => {
    __resetMockForTests();
    useStore.setState({ exec: originalExec });
    await st().refresh();
    calls = [];
    override = null;
    const real = st().exec;
    useStore.setState({
      exec: (async (command: string, args?: Record<string, unknown>, ...rest: unknown[]) => {
        calls.push({ command, args });
        const forced = override?.(command, args);
        if (forced) return forced;
        return (real as (...a: unknown[]) => Promise<CommandResult>)(command, args, ...rest);
      }) as typeof real,
    });
    useV3.setState({ pane: "none", browserTab: "files" });
  });
  afterEach(() => { useStore.setState({ exec: originalExec }); });

  it("lands a Keys track with ONE four-bar MIDI clip of 12 whole-bar chord notes, in one batch", async () => {
    const before = st().snapshot!;
    const dropped = await dropChords();
    expect(dropped).not.toBeNull();
    const after = st().snapshot!;
    expect(after.tracks.length).toBe(before.tracks.length + 1);
    const track = after.tracks.find((t) => t.id === dropped!.trackId)!;
    expect(track.name).toBe("Keys");
    expect(track.plugins?.some((p) => p.isInstrument && p.type === "4osc")).toBe(true);
    expect(track.clips.length).toBe(1);
    const clip = track.clips[0]!;
    expect(clip.id).toBe(dropped!.clipId);
    expect(clip.type).toBe("midi");
    const meter = meterFrom(after.session);
    expect(clip.length).toBeCloseTo(4 * barSeconds(meter), 6);
    // the progression, bar by bar: Am, F, C, G — whole-bar notes at velocity 90
    const notes = clip.notes ?? [];
    expect(notes.length).toBe(12);
    for (let bar = 0; bar < 4; bar++) {
      const inBar = notes.filter((n) => Math.abs(n.start - bar * meter.num) < 1e-9);
      expect(inBar.map((n) => n.pitch).sort((a, b) => a - b)).toEqual([...CHORD_PROGRESSION[bar]!].sort((a, b) => a - b));
      for (const n of inBar) { expect(n.length).toBeCloseTo(meter.num, 9); expect(n.velocity).toBe(90); }
    }
    expect(CHORD_PROGRESSION.map((c) => [...c])).toEqual([[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]);
    // one batch: every mutation sits between batch_begin and batch_end, the preset list is read first
    const seq = calls.map((c) => c.command).filter((c) => c !== "get_snapshot");
    const b = seq.indexOf("batch_begin"), e = seq.lastIndexOf("batch_end");
    expect(b).toBeGreaterThan(-1);
    expect(seq.slice(b, e + 1)).toEqual(["batch_begin", "create_track", "add_midi_clip", "add_note", "load_preset", "batch_end"]);
    expect(seq.indexOf("list_presets")).toBeLessThan(b);
    expect(calls.find((c) => c.command === "create_track")!.args).toMatchObject({ name: "Keys" });
    expect(String(calls.find((c) => c.command === "load_preset")!.args!.file)).toMatch(/keys/i);
    expect(dropped!.preset).toMatch(/keys/i);
  });

  it("selects the new track and opens the Browser on its Presets tab", async () => {
    const dropped = await dropChords();
    expect(st().selectedTrackId).toBe(dropped!.trackId);
    expect(useV3.getState().pane).toBe("browser");
    expect(useV3.getState().browserTab).toBe("presets");
  });

  it("one undo removes the whole thing", async () => {
    const before = st().snapshot!.tracks.map((t) => t.id);
    const dropped = await dropChords();
    expect(st().snapshot!.tracks.some((t) => t.id === dropped!.trackId)).toBe(true);
    await st().exec("undo");
    await st().refresh();
    expect(st().snapshot!.tracks.map((t) => t.id)).toEqual(before);
  });

  it("starts at bar 1 in an empty session, else at the bar at/before the playhead (the + Drum beat rule)", async () => {
    await st().exec("set_transport", { position: 2.7 });           // 1.35 bars at 120 BPM
    await st().refresh();
    const mid = await dropChords();
    const at = (id: string) => st().snapshot!.tracks.find((t) => t.id === id)!.clips[0]!.start;
    expect(at(mid!.trackId)).toBeCloseTo(2, 9);
    await st().exec("new_project", {});
    await st().exec("set_transport", { position: 5.3 });
    await st().refresh();
    const empty = await dropChords();
    expect(at(empty!.trackId)).toBe(0);
  });

  it("keeps the chords when there is no Keys preset (best effort) — still one undo step", async () => {
    override = (c) => (c === "list_presets" ? { ok: true, command: c, data: { presets: [{ name: "mosh-bass", file: "/presets/4osc/mosh-bass.json" }] } } : null);
    const before = st().snapshot!.tracks.length;
    const dropped = await dropChords();
    expect(dropped).not.toBeNull();
    expect(dropped!.preset).toBeNull();
    expect(calls.some((c) => c.command === "load_preset")).toBe(false);
    expect(st().snapshot!.tracks.find((t) => t.id === dropped!.trackId)!.clips[0]!.notes?.length).toBe(12);
    await st().exec("undo");
    await st().refresh();
    expect(st().snapshot!.tracks.length).toBe(before);
  });

  it("refuses (creates nothing) while another batch — a running Moshi task — holds the transaction", async () => {
    expect((await st().exec("batch_begin", { name: "agent" })).ok).toBe(true);
    const before = st().snapshot!.tracks.length;
    const dropped = await dropChords();
    expect(dropped).toBeNull();
    expect(calls.some((c) => c.command === "create_track")).toBe(false);
    expect(st().lastError).toMatch(/busy|working|wait/i);
    await st().exec("batch_end", {});
    await st().refresh();
    expect(st().snapshot!.tracks.length).toBe(before);
  });
});
