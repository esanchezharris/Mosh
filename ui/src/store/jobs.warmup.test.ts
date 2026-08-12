// GEN-WARMUP — cold-launch retry/backoff for the service-backed jobs-slice loaders.
//
// ensureServiceRunning() (native, GenerativeJobManager.cpp) can take several real seconds
// on a cold launch: spawning python3, importing the interpreter, and — under
// MOSH_ENABLE_SA3=1 — loading the MLX model (~1.7s+). Before the fix, loadColors() /
// loadTransformTargets() / loadLoras() were a ONE-SHOT fetch: whatever the first response
// was (including "generative service unavailable" from a still-cold-starting service)
// became the permanently-displayed state. There was no retry, so a producer who opened the
// Generate drawer within the first second or two of app launch got a stuck-empty rack
// (empty colours/LoRAs/targets) that never recovered unless they closed and reopened the
// drawer (remounting GenDrawer re-fires the same effect, re-arming the `.length > 0` guard).
//
// This test drives the SAME failure the real cold-start hits: the first N calls to
// executeCommand("list_colors"/...) resolve with the service-unavailable error shape
// (ok:false — exactly what MoshOps.Generative.cpp's cmdListColors/cmdListLoras/
// cmdListTransformTargets return while ensureServiceRunning() is still failing), then a
// later call succeeds once the service is actually up. It asserts the loaders keep retrying
// (bounded, with backoff) until they see that success — not just once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, executeCommand: vi.fn() };
});

import { executeCommand } from "../bridge";
import { useStore } from "../store";

const flush = async (n = 1) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("jobs slice — service warmup retry (GEN-WARMUP)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({
      availableColors: [], availableTransformTargets: [], availableLoras: [],
      sa3Available: undefined, transformFreeText: true,
    } as never);
  });

  afterEach(() => {
    vi.mocked(executeCommand).mockReset();
    vi.useRealTimers();
  });

  it("loadColors() keeps retrying through a cold-starting service instead of giving up after one failure", async () => {
    let call = 0;
    vi.mocked(executeCommand).mockImplementation(async () => {
      call += 1;
      // First two attempts land mid-cold-start (exactly cmdListColors' errResult shape);
      // the third finds the service healthy.
      if (call < 3) return { ok: false, error: "generative service unavailable" };
      return { ok: true, data: { colors: [{ id: "grit", label: "Grit", ceiling: 60 }], sa3: true } };
    });

    useStore.getState().loadColors();
    await flush();
    // First attempt failed — this alone is not the bug (a single cold-start miss is
    // expected). The bug is that nothing EVER retries it.
    expect(call).toBe(1);
    expect(useStore.getState().availableColors).toEqual([]);

    // Let the retry/backoff loop run out its clock. A real fix retries within the ticket's
    // ~15-20s ceiling; 20s of fake-timer advancement is well inside that budget for a
    // 2-attempt-then-succeed sequence.
    await vi.advanceTimersByTimeAsync(20000);
    await flush(3);

    expect(call, "loadColors() never retried the failed cold-start fetch").toBeGreaterThan(1);
    expect(useStore.getState().availableColors, "never recovered once the service came up")
      .toEqual([{ id: "grit", label: "Grit", ceiling: 60 }]);
  });

  it("loadLoras() and loadTransformTargets() also retry rather than latching the first failure", async () => {
    const responses: Record<string, () => Promise<unknown>> = {
      list_loras: (() => {
        let n = 0;
        return async () => {
          n += 1;
          if (n < 2) return { ok: false, error: "generative service unavailable" };
          return { ok: true, data: { loras: [{ id: "l1", name: "Take 1" }] } };
        };
      })(),
      list_transform_targets: (() => {
        let n = 0;
        return async () => {
          n += 1;
          if (n < 2) return { ok: false, error: "generative service unavailable" };
          return { ok: true, data: { targets: ["violin"], freeText: true } };
        };
      })(),
    };
    vi.mocked(executeCommand).mockImplementation(async (req: unknown) => {
      const command = (req as { command: string }).command;
      return responses[command]();
    });

    useStore.getState().loadLoras();
    useStore.getState().loadTransformTargets();
    await flush();
    await vi.advanceTimersByTimeAsync(20000);
    await flush(3);

    expect(useStore.getState().availableLoras).toEqual([{ id: "l1", name: "Take 1" }]);
    expect(useStore.getState().availableTransformTargets).toEqual([{ name: "violin" }]);
  });
});
