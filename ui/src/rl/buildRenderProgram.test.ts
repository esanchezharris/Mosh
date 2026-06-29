import { describe, it, expect } from "vitest";
import { buildRenderProgram } from "./buildRenderProgram";
import { __resetMockForTests, mockExecute } from "../bridge.mock";
import { runBound } from "../gepa/metric";
import type { EvalExample } from "../gepa/evalset";
import type { BoundCommand } from "../import/emit";
import type { CommandResult } from "../types";

const OUT = "/tmp/rl/o.wav";
const ex = (startCommands: BoundCommand[]): EvalExample => ({
  id: "t#0", utterance: "add a bassline", startCommands, goldCommandNames: ["add_note"],
});
const reply = (commands: unknown[]) => JSON.stringify({ intent: "ACK_GOT_IT", commands });

/** The mock is deterministic after reset, so we can learn the id a startCommand will
 *  produce, then assert buildRenderProgram (which resets + replays identically) remaps it. */
async function mockIdsFor(start: BoundCommand[]): Promise<Map<string, string>> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  await runBound(start, env);
  return env;
}

describe("buildRenderProgram", () => {
  it("defers (no render) on an empty reply", async () => {
    const r = await buildRenderProgram(ex([]), reply([]), OUT);
    expect(r).toEqual({ lines: [], seedLines: [], deferred: true, warnings: [] });
  });

  it("emits seedLines = startCommands + export(.seed.wav), WITHOUT the edit (delta-reward baseline)", async () => {
    const start: BoundCommand[] = [
      { command: "create_track", args: { name: "Drums", type: "drum" }, bind: "t0" },
      { command: "add_midi_clip", args: { trackId: "$t0", start: 0, notes: [{ pitch: 36, start: 0, length: 0.5, velocity: 120 }] }, bind: "c0" },
    ];
    const r = await buildRenderProgram(ex(start), reply([{ command: "set_track_volume", args: { trackId: "$t0", db: 2 } }]), OUT);
    // seedLines: the two startCommands (translated) + an export to the sibling .seed.wav — NO reply command
    expect(r.seedLines.map((l) => l.command)).toEqual(["create_track", "add_midi_clip", "export_audio"]);
    expect(r.seedLines.at(-1)).toEqual({ command: "export_audio", args: { file: "/tmp/rl/o.seed.wav", format: "wav" } });
    expect(r.seedLines.some((l) => l.command === "set_track_volume")).toBe(false);
    // full lines DO include the edit, and the seed is a strict prefix (minus exports)
    expect(r.lines.some((l) => l.command === "set_track_volume")).toBe(true);
  });

  it("translates startCommands: bind→capture, $ref→${ref}", async () => {
    const start: BoundCommand[] = [
      { command: "create_track", args: { name: "Bass", type: "audio" }, bind: "t0" },
      { command: "add_midi_clip", args: { trackId: "$t0", start: 0 }, bind: "c0" },
    ];
    const r = await buildRenderProgram(ex(start), reply([{ command: "set_tempo", args: { bpm: 120 } }]), OUT);
    expect(r.lines[0]).toEqual({ command: "create_track", args: { name: "Bass", type: "audio" }, capture: { t0: "trackId" } });
    expect(r.lines[1]).toEqual({ command: "add_midi_clip", args: { trackId: "${t0}", start: 0 }, capture: { c0: "clipId" } });
  });

  it("remaps a reply id that points at a setup-created track → ${var}", async () => {
    const start: BoundCommand[] = [{ command: "create_track", args: { name: "Bass" }, bind: "t0" }];
    const bassId = (await mockIdsFor(start)).get("t0")!;
    expect(bassId).toBeTruthy();
    const r = await buildRenderProgram(
      ex(start),
      reply([{ command: "add_midi_clip", args: { trackId: bassId, start: 0 } }]),
      OUT,
    );
    const clip = r.lines.find((l) => l.command === "add_midi_clip")!;
    expect(clip.args.trackId).toBe("${t0}"); // remapped, not the raw mock id
    expect(r.deferred).toBe(false);
  });

  it("leaves an unresolvable numeric id verbatim + warns", async () => {
    const start: BoundCommand[] = [{ command: "create_track", args: { name: "Bass" }, bind: "t0" }];
    const r = await buildRenderProgram(
      ex(start),
      reply([{ command: "add_note", args: { clipId: "9999", pitch: 60, start: 0, length: 1 } }]),
      OUT,
    );
    const note = r.lines.find((l) => l.command === "add_note")!;
    expect(note.args.clipId).toBe("9999"); // not a setup id → left as-is
    expect(r.warnings.some((w) => w.includes("9999"))).toBe(true);
  });

  it("always ends with an export_audio to the reward WAV", async () => {
    const r = await buildRenderProgram(ex([]), reply([{ command: "set_tempo", args: { bpm: 90 } }]), OUT);
    expect(r.lines.at(-1)).toEqual({ command: "export_audio", args: { file: OUT, format: "wav" } });
  });
});
