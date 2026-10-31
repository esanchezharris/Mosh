import { describe, expect, it } from "vitest";
import type { CommandResult } from "../types";
import {
  BPM_SURE, bpmFromName, clampBpm, confirmTempo, detectBpm, doubleBpm, formatBpm, halveBpm, importBeat,
  looksLikeAudioName, MAX_BPM, MIN_BPM, proposeTempo, type Exec,
} from "./beatImport";

type Call = { command: string; args?: Record<string, unknown> };

/** A fake exec that records every call and answers from a per-command table (default ok). */
function fakeExec(answers: Record<string, CommandResult | null | (() => never)> = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    if (command in answers) {
      const a = answers[command];
      if (typeof a === "function") return a();
      return a;
    }
    return { ok: true, command };
  };
  return { exec, calls, commands: () => calls.map((c) => c.command) };
}

describe("bpmFromName", () => {
  it("reads a BPM from the file name", () => {
    expect(bpmFromName("late night 88bpm.wav")).toBe(88);
    expect(bpmFromName("beat_140 BPM.mp3")).toBe(140);
    expect(bpmFromName("Trap 160Bpm F#m.wav")).toBe(160);
  });
  it("ignores tempos outside 40..240", () => {
    expect(bpmFromName("slow 30bpm.wav")).toBeNull();
    expect(bpmFromName("fast 250bpm.wav")).toBeNull();
  });
  it("is null when the name names no tempo", () => {
    expect(bpmFromName("my beat.wav")).toBeNull();
    expect(bpmFromName("take 9bpm.wav")).toBeNull();
    expect(bpmFromName("88 beats.wav")).toBeNull();
  });
});

describe("proposeTempo", () => {
  it("takes the name when detection agrees within ±2", () => {
    expect(proposeTempo({ bpm: 89.6, confidence: 0.1 }, "x 88bpm.wav", 120)).toEqual({ bpm: 88, source: "name", sure: true });
    expect(proposeTempo({ bpm: 86, confidence: 0.9 }, "x 88bpm.wav", 120)).toEqual({ bpm: 88, source: "name", sure: true });
  });

  it("takes the name when detection is double or half of it", () => {
    expect(proposeTempo({ bpm: 120, confidence: 0.9 }, "x 60bpm.wav", 100)).toEqual({ bpm: 60, source: "name", sure: true });
    expect(proposeTempo({ bpm: 100, confidence: 0.9 }, "x 200bpm.wav", 100)).toEqual({ bpm: 200, source: "name", sure: true });
  });

  it("takes the name when there is no detection", () => {
    expect(proposeTempo(null, "x 88bpm.wav", 120)).toEqual({ bpm: 88, source: "name", sure: true });
  });

  it("takes detection when it disagrees with the name", () => {
    expect(proposeTempo({ bpm: 91, confidence: 0.9 }, "x 88bpm.wav", 120)).toEqual({ bpm: 91, source: "detected", sure: true });
  });

  it("takes detection alone, sure exactly at the BPM_SURE threshold and not below it", () => {
    expect(proposeTempo({ bpm: 93.27, confidence: BPM_SURE }, "beat.wav", 120)).toEqual({ bpm: 93.3, source: "detected", sure: true });
    expect(proposeTempo({ bpm: 93, confidence: BPM_SURE - 0.01 }, "beat.wav", 120)).toEqual({ bpm: 93, source: "detected", sure: false });
  });

  it("falls back to the session tempo, never sure, when nothing was found", () => {
    expect(proposeTempo(null, "beat.wav", 97)).toEqual({ bpm: 97, source: "session", sure: false });
    expect(proposeTempo({ bpm: 0, confidence: 1 }, "beat.wav", 97)).toEqual({ bpm: 97, source: "session", sure: false });
    expect(proposeTempo(null, "beat.wav", 0)).toEqual({ bpm: 120, source: "session", sure: false });
    expect(proposeTempo(null, "beat.wav", 999)).toEqual({ bpm: MAX_BPM, source: "session", sure: false });
  });
});

describe("clampBpm / halve / double / format", () => {
  it("clamps to 40..240 and rounds to one decimal", () => {
    expect(clampBpm(10)).toBe(MIN_BPM);
    expect(clampBpm(500)).toBe(MAX_BPM);
    expect(clampBpm(40)).toBe(40);
    expect(clampBpm(240)).toBe(240);
    expect(clampBpm(93.27)).toBe(93.3);
  });
  it("answers 120 for NaN and infinities", () => {
    expect(clampBpm(Number.NaN)).toBe(120);
    expect(clampBpm(Number.POSITIVE_INFINITY)).toBe(120);
    expect(clampBpm(Number.NEGATIVE_INFINITY)).toBe(120);
  });
  it("halves and doubles inside the bounds", () => {
    expect(halveBpm(176)).toBe(88);
    expect(doubleBpm(44)).toBe(88);
    expect(halveBpm(60)).toBe(MIN_BPM);
    expect(doubleBpm(150)).toBe(MAX_BPM);
  });
  it("shows whole tempos whole and others with one decimal", () => {
    expect(formatBpm(88)).toBe("88");
    expect(formatBpm(93.3)).toBe("93.3");
    expect(formatBpm(87.5)).toBe("87.5");
  });
});

describe("looksLikeAudioName", () => {
  it.each(["beat.wav", "Beat.WAV", "x.aif", "x.aiff", "x.flac", "x.mp3", "x.ogg"])("accepts %s", (n) => {
    expect(looksLikeAudioName(n)).toBe(true);
  });
  it.each(["notes.txt", "wav", "beat.wav.zip", "beat.m4a", ""])("rejects %j", (n) => {
    expect(looksLikeAudioName(n)).toBe(false);
  });
});

describe("importBeat", () => {
  const imported = (data: Record<string, unknown>): CommandResult => ({ ok: true, command: "import", data });

  it("imports a file by path onto Backing at 0 seconds", async () => {
    const f = fakeExec({ import_clip: imported({ clipId: "c1", trackId: "B" }) });
    const r = await importBeat(f.exec, { kind: "path", file: "/beats/a.wav" }, "B", null);
    expect(r).toEqual({ ok: true, clipId: "c1", error: null });
    expect(f.calls).toEqual([{ command: "import_clip", args: { file: "/beats/a.wav", trackId: "B", startSeconds: 0 } }]);
  });

  it("imports dropped data onto Backing at 0", async () => {
    const f = fakeExec({ import_clip_data: imported({ clipId: "c2", trackId: "B" }) });
    const r = await importBeat(f.exec, { kind: "data", name: "a.wav", dataBase64: "QUJD" }, "B", null);
    expect(r).toEqual({ ok: true, clipId: "c2", error: null });
    expect(f.calls).toEqual([{ command: "import_clip_data", args: { name: "a.wav", dataBase64: "QUJD", trackId: "B", start: 0 } }]);
  });

  it("removes the previous beat first, so a second drop replaces it", async () => {
    const f = fakeExec({ import_clip: imported({ clipId: "c2", trackId: "B" }) });
    const r = await importBeat(f.exec, { kind: "path", file: "/b.wav" }, "B", "c1");
    expect(r.ok).toBe(true);
    expect(f.calls[0]).toEqual({ command: "remove_clip", args: { clipId: "c1" } });
    expect(f.commands()).toEqual(["remove_clip", "import_clip"]);
  });

  it("tolerates a previous beat that is already gone", async () => {
    const f = fakeExec({
      remove_clip: { ok: false, command: "remove_clip", error: "no clip" },
      import_clip: imported({ clipId: "c2", trackId: "B" }),
    });
    expect(await importBeat(f.exec, { kind: "path", file: "/b.wav" }, "B", "c1")).toEqual({ ok: true, clipId: "c2", error: null });
    expect(f.commands()).toEqual(["remove_clip", "import_clip"]);
  });

  it("aborts with no import when the previous beat cannot be removed", async () => {
    const f = fakeExec({ remove_clip: { ok: false, command: "remove_clip", error: "clip is locked" } });
    expect(await importBeat(f.exec, { kind: "path", file: "/b.wav" }, "B", "c1"))
      .toEqual({ ok: false, clipId: null, error: "clip is locked" });
    expect(f.commands()).toEqual(["remove_clip"]);
  });

  it("aborts with a default message when the remove gets no answer", async () => {
    const f = fakeExec({ remove_clip: null });
    expect(await importBeat(f.exec, { kind: "path", file: "/b.wav" }, "B", "c1"))
      .toEqual({ ok: false, clipId: null, error: "Couldn't replace the previous beat" });
    expect(f.commands()).toEqual(["remove_clip"]);
  });

  it("undoes a beat that landed on another track and reports it", async () => {
    const f = fakeExec({ import_clip: imported({ clipId: "c1", trackId: "VOCAL" }) });
    const r = await importBeat(f.exec, { kind: "path", file: "/b.wav" }, "B", null);
    expect(r.ok).toBe(false);
    expect(r.clipId).toBeNull();
    expect(r.error).toMatch(/Backing track went missing/);
    expect(f.calls[1]).toEqual({ command: "undo", args: {} });
    expect(f.commands()).toEqual(["import_clip", "undo"]);
  });

  it("passes a refused import's error through", async () => {
    const f = fakeExec({ import_clip_data: { ok: false, command: "import_clip_data", error: "unsupported format" } });
    expect(await importBeat(f.exec, { kind: "data", name: "a.wav", dataBase64: "x" }, "B", null))
      .toEqual({ ok: false, clipId: null, error: "unsupported format" });
    expect(f.commands()).not.toContain("undo");
  });

  it("uses a default message for a refused import with no error", async () => {
    const f = fakeExec({ import_clip: null });
    expect(await importBeat(f.exec, { kind: "path", file: "/b.wav" }, "B", null))
      .toEqual({ ok: false, clipId: null, error: "The beat couldn't be added" });
  });

  it("is not ok when the engine does not name the new clip", async () => {
    const f = fakeExec({ import_clip: imported({ trackId: "B" }) });
    expect(await importBeat(f.exec, { kind: "path", file: "/b.wav" }, "B", null))
      .toEqual({ ok: false, clipId: null, error: "The engine didn't name the new clip" });
  });
});

describe("detectBpm", () => {
  it("returns the detected tempo and confidence", async () => {
    const f = fakeExec({ detect_clip_bpm: { ok: true, command: "detect_clip_bpm", data: { bpm: 88.2, confidence: 0.7 } } });
    expect(await detectBpm(f.exec, "c1")).toEqual({ bpm: 88.2, confidence: 0.7 });
    expect(f.calls).toEqual([{ command: "detect_clip_bpm", args: { clipId: "c1" } }]);
  });
  it("treats a missing confidence as 0", async () => {
    const f = fakeExec({ detect_clip_bpm: { ok: true, command: "detect_clip_bpm", data: { bpm: 90 } } });
    expect(await detectBpm(f.exec, "c1")).toEqual({ bpm: 90, confidence: 0 });
  });
  it("is null for a refusal, no answer, a zero or non-numeric bpm, or a throw", async () => {
    expect(await detectBpm(fakeExec({ detect_clip_bpm: { ok: false, command: "d", data: { bpm: 90 } } }).exec, "c")).toBeNull();
    expect(await detectBpm(fakeExec({ detect_clip_bpm: null }).exec, "c")).toBeNull();
    expect(await detectBpm(fakeExec({ detect_clip_bpm: { ok: true, command: "d", data: { bpm: 0, confidence: 1 } } }).exec, "c"))
      .toBeNull();
    expect(await detectBpm(fakeExec({ detect_clip_bpm: { ok: true, command: "d", data: { bpm: "90" } } }).exec, "c")).toBeNull();
    const throwing = fakeExec({ detect_clip_bpm: () => { throw new Error("bridge gone"); } });
    expect(await detectBpm(throwing.exec, "c")).toBeNull();
  });
});

describe("confirmTempo", () => {
  it("sets the tempo, then loops the clip, in that order", async () => {
    const f = fakeExec();
    expect(await confirmTempo(f.exec, 88, { start: 2, length: 10.5 })).toBeNull();
    expect(f.calls).toEqual([
      { command: "set_tempo", args: { bpm: 88 } },
      { command: "set_transport", args: { loop: true, loopStart: 2, loopEnd: 12.5 } },
    ]);
  });

  it("clamps the tempo it writes", async () => {
    const f = fakeExec();
    await confirmTempo(f.exec, 500, { start: 0, length: 4 });
    expect(f.calls[0]).toEqual({ command: "set_tempo", args: { bpm: MAX_BPM } });
  });

  it("stops at a refused tempo without touching the loop", async () => {
    const f = fakeExec({ set_tempo: { ok: false, command: "set_tempo", error: "tempo locked" } });
    expect(await confirmTempo(f.exec, 88, { start: 0, length: 4 })).toBe("tempo locked");
    expect(f.commands()).toEqual(["set_tempo"]);
    expect(await confirmTempo(fakeExec({ set_tempo: null }).exec, 88, { start: 0, length: 4 })).toBe("Couldn't set the tempo");
  });

  it("reports a refused loop", async () => {
    const f = fakeExec({ set_transport: { ok: false, command: "set_transport", error: "bad range" } });
    expect(await confirmTempo(f.exec, 88, { start: 0, length: 4 })).toBe("bad range");
    expect(f.commands()).toEqual(["set_tempo", "set_transport"]);
    expect(await confirmTempo(fakeExec({ set_transport: null }).exec, 88, { start: 0, length: 4 })).toBe("Couldn't loop the beat");
  });
});
