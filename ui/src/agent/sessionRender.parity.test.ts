import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { renderSession } from "./sessionRender";
import type { Snapshot } from "../types";

// service/sft/build_add_note_corrective.py hand-mirrors renderSession in Python
// (it parses commands.ts for the CATALOG, but hand-copies the session render).
// Its docstring used to say "kept in sync by hand" with nothing enforcing it —
// and it duly fell out of sync. This is the enforcement.
//
// Why this lives in ui/ and not beside the Python: drift travels one way. The
// renderer is TypeScript; the Python is the copy. The cheap gate's Python suite
// is path-scoped to service/, so a guard there would stay silent for exactly the
// edit that breaks it — a TypeScript-only renderer change.
const SFT_DIR = resolve(__dirname, "../../../service/sft");

function pythonRenderSession(trackId: string, trackName: string, clipId: string): string {
  return execFileSync("python3", [
    "-c",
    [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(SFT_DIR)})`,
      "from build_add_note_corrective import render_session",
      `sys.stdout.write(render_session(${JSON.stringify(trackId)}, ${JSON.stringify(trackName)}, ${JSON.stringify(clipId)}))`,
    ].join("\n"),
  ], { encoding: "utf8" });
}

// The session shape the Python builder targets: one track, one MIDI clip at 0s,
// no key, no tempo map, no buses, master at its zero defaults.
const FIXTURE = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, length: 16, editFile: "" },
  tracks: [
    { id: "4000", index: 0, name: "Melody", type: "midi", volumeDb: 0, mute: false, solo: false,
      clips: [{ id: "4001", name: "pattern", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
} as unknown as Snapshot;

describe("sessionRender ↔ Python mirror parity", () => {
  it("build_add_note_corrective.py::render_session matches renderSession byte-for-byte", () => {
    expect(pythonRenderSession("4000", "Melody", "4001")).toBe(renderSession(FIXTURE));
  });

  it("the mirrored render actually carries the master line (the fixture is not vacuous)", () => {
    // A parity test between two renderers that both dropped master would pass
    // while the bug was fully present. Pin the content, not just the agreement.
    expect(renderSession(FIXTURE)).toContain("master: 0dB pan 0 chain:[empty]");
  });
});
