import { describe, expect, it, vi } from "vitest";
import type { ChangeSet } from "./executor";
import { runStudioSkill, type StudioContext, type StudioSkillEnvironment } from "./studioSkills";
import type { CommandResult } from "../types";

const PLUGINS = [
  { id: "serum-1", name: "Serum", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
  { id: "serum-2", name: "Serum 2", format: "VST3", manufacturer: "Xfer Records", isInstrument: true },
  { id: "serum-2-fx", name: "Serum 2 FX", format: "VST3", manufacturer: "Xfer Records", isInstrument: false },
] as const;

function successfulChanges(): ChangeSet {
  return {
    label: "load Serum 2",
    applied: 1,
    entries: [{ index: 0, command: "load_plugin", summary: "Added a plugin", ok: true }],
  };
}

function environment(options: {
  readonly selectedTrackId?: string | null;
  readonly pluginData?: unknown;
  readonly listError?: string;
  readonly loadError?: string;
  readonly onRunBatch?: () => void;
} = {}): { readonly value: StudioSkillEnvironment; readonly exec: ReturnType<typeof vi.fn>; readonly runBatch: ReturnType<typeof vi.fn>; readonly setEpoch: (epoch: number) => void } {
  let context: StudioContext = {
    projectEpoch: 12,
    selectedTrackId: options.selectedTrackId === undefined ? "synth" : options.selectedTrackId,
    tracks: [{ id: "synth", name: "Synth" }],
  };
  const exec = vi.fn(async (command: string): Promise<CommandResult> => {
    if (command !== "list_plugins") return { ok: false, command, error: "unexpected command" };
    if (options.listError) return { ok: false, command, error: options.listError };
    return {
      ok: true,
      command,
      data: options.pluginData === undefined ? { plugins: PLUGINS } : options.pluginData,
    };
  });
  const runBatch = vi.fn(async (): Promise<ChangeSet> => {
    options.onRunBatch?.();
    if (!options.loadError) return successfulChanges();
    return {
      label: "load Serum 2",
      applied: 0,
      entries: [{ index: 0, command: "load_plugin", summary: "Added a plugin", ok: false, error: options.loadError }],
    };
  });
  return {
    value: { context: () => context, exec, runBatch },
    exec,
    runBatch,
    setEpoch: (epoch) => { context = { ...context, projectEpoch: epoch }; },
  };
}

describe("runStudioSkill", () => {
  it("asks for a track before reading the plug-in catalog", async () => {
    const harness = environment({ selectedTrackId: null });
    const outcome = await runStudioSkill("load Serum 2", harness.value);
    expect(outcome.kind).toBe("needs_choice");
    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.runBatch).not.toHaveBeenCalled();
  });

  it("blocks a malformed catalog without mutating the session", async () => {
    const harness = environment({ pluginData: { plugins: [{ id: "broken" }] } });
    const outcome = await runStudioSkill("load Serum 2", harness.value);
    expect(outcome.kind).toBe("blocked");
    expect(harness.runBatch).not.toHaveBeenCalled();
  });

  it("bounds an oversized catalog instead of carrying it into orchestration", async () => {
    const oversized = Array.from({ length: 4_097 }, (_, index) => ({
      id: `plugin-${index}`,
      name: `Plug-in ${index}`,
      format: "VST3",
      manufacturer: "Fixture",
      isInstrument: false,
    }));
    const harness = environment({ pluginData: { plugins: oversized } });
    const outcome = await runStudioSkill("load Plug-in 1", harness.value);
    expect(outcome.kind).toBe("blocked");
    expect(harness.runBatch).not.toHaveBeenCalled();
  });

  it("rejects the mutation when the project changes after observation", async () => {
    const harness = environment();
    harness.exec.mockImplementationOnce(async () => {
      harness.setEpoch(13);
      return { ok: true, command: "list_plugins", data: { plugins: PLUGINS } };
    });
    const outcome = await runStudioSkill("load Serum 2", harness.value);
    expect(outcome.kind).toBe("blocked");
    expect(harness.runBatch).not.toHaveBeenCalled();
  });

  it("returns a bounded choice instead of guessing between equivalent matches", async () => {
    const duplicates = Array.from({ length: 8 }, (_, index) => ({
      id: `serum-2-${index}`,
      name: "Serum 2",
      format: index % 2 === 0 ? "VST3" : "AudioUnit",
      manufacturer: `Xfer ${index}`,
      isInstrument: true,
    }));
    const harness = environment({ pluginData: { plugins: duplicates } });
    const outcome = await runStudioSkill("please load serum 2", harness.value);
    expect(outcome.kind).toBe("needs_choice");
    if (outcome.kind === "needs_choice") expect(outcome.options).toHaveLength(5);
    expect(harness.runBatch).not.toHaveBeenCalled();
  });

  it("suggests a rescan when no installed plug-in matches", async () => {
    const harness = environment();
    const outcome = await runStudioSkill("load Omnisphere", harness.value);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.say).toContain("rescan");
    expect(harness.runBatch).not.toHaveBeenCalled();
  });

  it("turns the native instrument-on-audio refusal into actionable guidance", async () => {
    const harness = environment({ loadError: "instrument refused on track holding audio clips" });
    const outcome = await runStudioSkill("load Serum 2", harness.value);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.say).toContain("instrument track");
  });

  it("does not claim completion if the project changes during the load", async () => {
    const harness = environment({ onRunBatch: () => harness.setEpoch(13) });
    const outcome = await runStudioSkill("load Serum 2", harness.value);
    expect(outcome.kind).toBe("blocked");
  });

  it("fails closed for unsupported asks without reading or mutating anything", async () => {
    const harness = environment();
    const outcome = await runStudioSkill("make the whole mix warmer", harness.value);
    expect(outcome.kind).toBe("unsupported");
    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.runBatch).not.toHaveBeenCalled();
  });
});
