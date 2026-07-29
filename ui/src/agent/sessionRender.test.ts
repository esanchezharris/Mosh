import { describe, it, expect } from "vitest";
import { renderSession } from "./sessionRender";
import type { Snapshot } from "../types";

// The master chain is the one place the prompt names a plugin the model may then
// have to reference in a command. Which string it shows is therefore a contract,
// not cosmetics: load_master_builtin/load_builtin take the builtin's `type` id,
// and the engine's table (MoshOps.cpp kBuiltins) makes type and display name
// deliberately different — "compressor"/"Compressor", "4bandEq"/"4-Band EQ".
//
// Measured 2026-07-28 (docs/agent-bench/REPORT_2026-07-28-session-render.md):
// with the chain rendered as display names, master-eq-before-comp emitted
// `unknown builtin: EQ` in 13 of 13 reps.
const withMasterPlugins = (plugins: unknown[]): Snapshot => ({
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, length: 16, editFile: "" },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: -3, pan: 0, plugins },
} as unknown as Snapshot);

const chainOf = (s: Snapshot): string =>
  renderSession(s).split("\n").find((l) => l.startsWith("master:"))!;

describe("renderSession — master chain names builtins by the id commands take", () => {
  it("renders a builtin by its `type`, not its display name", () => {
    const s = withMasterPlugins([{ index: 0, name: "Compressor", type: "compressor", builtin: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[compressor]");
    // the display name must NOT appear — it is the string the engine rejects
    expect(chainOf(s)).not.toContain("Compressor");
  });

  it("renders the EQ builtin as 4bandEq — the case no amount of re-casing reaches", () => {
    // "4-Band EQ" -> "4bandEq" is not a casing difference. A model copying the
    // display name cannot recover by lowercasing it.
    const s = withMasterPlugins([{ index: 0, name: "4-Band EQ", type: "4bandEq", builtin: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[4bandEq]");
  });

  it("keeps an EXTERNAL plugin's display name (its `type` is only a format label)", () => {
    // te::ExternalPlugin::getPluginType() returns "vst" — rendering that would
    // make every third-party plugin indistinguishable from every other.
    const s = withMasterPlugins([{ index: 0, name: "Pro-Q 3", type: "vst", builtin: false, external: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[Pro-Q 3]");
  });

  it("mixes builtins and externals in chain order", () => {
    const s = withMasterPlugins([
      { index: 0, name: "4-Band EQ", type: "4bandEq", builtin: true, enabled: true },
      { index: 1, name: "Pro-Q 3", type: "vst", builtin: false, external: true, enabled: true },
      { index: 2, name: "Compressor", type: "compressor", builtin: true, enabled: true },
    ]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[4bandEq, Pro-Q 3, compressor]");
  });

  it("falls back to the name when a plugin carries no type (defensive, not a real snapshot)", () => {
    const s = withMasterPlugins([{ index: 0, name: "Mystery", builtin: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[Mystery]");
  });

  it("still says empty for a bare master", () => {
    expect(chainOf(withMasterPlugins([]))).toBe("master: -3dB pan 0 chain:[empty]");
  });
});
