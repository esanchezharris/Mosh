// AUD-SCAN — AudioUnits were unreachable in the shipped app. The native rescan handler
// gated AU behind the MOSH_SCAN_AU env var, which is set in exactly ONE place in the whole
// tree (src/Main.cpp, for the --scan-plugins-deep CLI) — nothing in run-mosh.sh, CMake, or
// the Info.plist sets it. Worse, an explicit format:"au" request that failed the gate fell
// into the VST3-only branch and returned status:"done" with a count, so the caller was told
// the scan had happened. On a Mac, where plenty of instruments ship AU-only, that reads as
// "Mosh can't see my plugins" with no error to explain it.
//
// These specs pin the two halves of the fix: the store must carry the per-call opt-in, and
// asking for AU without it must FAIL LOUDLY rather than report a silent success.

import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { __resetMockForTests } from "../bridge.mock";
import { executeCommand } from "../bridge";
import type { CommandResult } from "../types";

describe("plugin rescan — the AudioUnit opt-in (AUD-SCAN)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("defaults to off, so the first scan stays fast and safe", () => {
    expect(useSettings.getState().get("scanAudioUnits")).toBe(false);
  });

  it("an explicit AU request without the opt-in FAILS rather than reporting a silent success", async () => {
    const res = await executeCommand<CommandResult>({ command: "rescan_plugins", args: { format: "au" } });
    expect(res.ok).toBe(false);
    expect(res.error ?? "").toMatch(/audio unit/i);
  });

  it("an AU request WITH the opt-in is accepted", async () => {
    const res = await executeCommand<CommandResult>({
      command: "rescan_plugins",
      args: { format: "au", allowAU: true },
    });
    expect(res.ok).toBe(true);
  });

  it("rescanPlugins forwards the opt-in to the backend", async () => {
    const seen: Record<string, unknown>[] = [];
    const real = useStore.getState().exec;
    useStore.setState({
      exec: async (command: string, args?: Record<string, unknown>) => {
        if (command === "rescan_plugins") seen.push(args ?? {});
        return real(command, args);
      },
    });

    await useStore.getState().rescanPlugins("vst3", false);
    await useStore.getState().rescanPlugins("all", true);

    expect(seen).toEqual([
      { format: "vst3", allowAU: false },
      { format: "all", allowAU: true },
    ]);
    useStore.setState({ exec: real });
  });
});
