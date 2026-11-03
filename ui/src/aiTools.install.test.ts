// "Add AI tools" (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.3), UI side: the bridge's
// status parsing, the dev mock's installer (it walks the steps native walks and emits the
// same ai_tools events), and the store re-reading snapshot.aiTools when a job ends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiToolsCancel, aiToolsInstall, aiToolsRemove, aiToolsStatus, onEvent, parseAiToolsInstallStatus } from "./bridge";
import { __mockAiToolsOffForTests, __resetMockForTests } from "./bridge.mock";
import { useStore } from "./store";
import { aiToolsOf } from "./aiTools";
import type { AiToolsInstallStatus, Snapshot } from "./types";

describe("parseAiToolsInstallStatus", () => {
  it("reads nothing (an older native) as unavailable, never as an Install that cannot work", () => {
    for (const v of [undefined, null, {}, { state: "bogus", available: true }]) {
      const st = parseAiToolsInstallStatus(v);
      expect(st.available).toBe(false);
      expect(st.state).toBe("unavailable");
      expect(st.steps.map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
    }
  });
  it("keeps the native fields and normalizes unknown step values", () => {
    const st = parseAiToolsInstallStatus({
      available: true, state: "failed", step: "sketch",
      steps: [{ id: "python", status: "done" }, { id: "sketch", status: "failed" }, { id: "transcribe", status: "??" }],
      error: "Couldn't install the beatbox tool. Check your internet and try again.",
      detail: "error: fake", sizeEstimateMb: 900,
    });
    expect(st).toMatchObject({ available: true, state: "failed", step: "sketch", detail: "error: fake", sizeEstimateMb: 900 });
    expect(st.steps.map((s) => s.status)).toEqual(["done", "failed", "pending"]);
  });
});

describe("the mock installer", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    __resetMockForTests();
    __mockAiToolsOffForTests();
    useStore.getState().init();
    await useStore.getState().refresh();
  });
  afterEach(() => vi.useRealTimers());

  it("starts on a friend's Mac with the tools off and the installer idle", async () => {
    expect(aiToolsOf(useStore.getState().snapshot).on).toBe(false);
    const st = await aiToolsStatus();
    expect(st).toMatchObject({ available: true, state: "idle", sizeEstimateMb: 850 });
  });

  it("walks python → sketch → transcribe, emits ai_tools, and the store sees the tools on", async () => {
    const seen: string[] = [];
    const pythonStarts: string[] = [];
    const off = onEvent("ai_tools", (p) => {
      const st = p as AiToolsInstallStatus;
      seen.push(`${st.state}:${st.step}`);
      if (st.steps[0].status === "running") pythonStarts.push(st.step);
    });
    const first = await aiToolsInstall();
    expect(first.state).toBe("installing");
    // A second click while it runs starts nothing new.
    await aiToolsInstall();
    await vi.advanceTimersByTimeAsync(2000);
    off();

    expect(seen).toContain("installing:python");
    expect(seen).toContain("installing:sketch");
    expect(seen).toContain("installing:transcribe");
    expect(seen.at(-1)).toBe("done:");
    // The second click did not start the download again.
    expect(pythonStarts).toEqual(["python"]);

    const st = await aiToolsStatus();
    expect(st.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    // The store re-read the snapshot on "done": Beatbox is back, Re-Imagine is not (no SA3).
    await vi.runAllTimersAsync();
    const tools = aiToolsOf(useStore.getState().snapshot);
    expect(tools).toEqual({ on: true, transcribe: true, sa3: false });
  });

  it("cancel keeps finished steps and leaves the tools off", async () => {
    await aiToolsInstall();
    await vi.advanceTimersByTimeAsync(300);   // python done, sketch running
    const st = await aiToolsCancel();
    expect(st.state).toBe("cancelled");
    expect(st.steps.map((s) => s.status)).toEqual(["done", "cancelled", "pending"]);
    await vi.runAllTimersAsync();
    expect(aiToolsOf(useStore.getState().snapshot).on).toBe(false);
  });

  it("remove turns the tools off again", async () => {
    await aiToolsInstall();
    await vi.advanceTimersByTimeAsync(2000);
    const st = await aiToolsRemove();
    expect(st.state).toBe("removed");
    await vi.runAllTimersAsync();
    expect(aiToolsOf(useStore.getState().snapshot).on).toBe(false);
  });
});

describe("?mockFault=ai-install-fail", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
    vi.resetModules();
  });

  it("fails the beatbox step with native's copy, and a retry succeeds", async () => {
    window.history.replaceState({}, "", "/?mockFault=ai-install-fail&mockAiTools=off");
    vi.resetModules();
    vi.useFakeTimers();
    const bridge = await import("./bridge");
    const mock = await import("./bridge.mock");
    mock.__resetMockForTests();

    await bridge.aiToolsInstall();
    await vi.advanceTimersByTimeAsync(2000);
    let st = await bridge.aiToolsStatus();
    expect(st.state).toBe("failed");
    expect(st.step).toBe("sketch");
    expect(st.error).toBe("Couldn't install the beatbox tool. Check your internet and try again.");
    expect(st.detail).toContain("librosa");
    expect((await mock.mockSnapshot<Snapshot>()).aiTools?.state).toBe("off");

    await bridge.aiToolsInstall();
    await vi.advanceTimersByTimeAsync(2000);
    st = await bridge.aiToolsStatus();
    expect(st.state).toBe("done");
    expect((await mock.mockSnapshot<Snapshot>()).aiTools?.state).toBe("on");
  });
});
