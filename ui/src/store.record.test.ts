// G2a — recording permission / failure UX.
//
// enterRecord arms the selected track, then starts the transport recording. The
// real engine degrades a no-input / mic-permission situation in TWO distinct ways:
//   1. arm_track returns ok:false (a live device rejected the target), OR
//   2. arm_track returns ok:true with data.applied:false + data.reason
//      ("no input device") — the graceful-no-op path proven by the conformance
//      "no fake clip on failure" invariant (MoshOps.cpp / conformance 45/49).
//
// Either way the user must get a CLEAR, persistent error state (the store's
// `lastError`, rendered as a role="alert" bar in both shells), and the doomed
// record must NOT be started. On a successful arm, any stale error clears and
// recording proceeds.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "./store";
import { __resetMockForTests } from "./bridge.mock";
import type { CommandResult } from "./types";

describe("enterRecord — no-input / mic-permission failure UX (G2a)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    // Pick an audio track to record into.
    const t = useStore.getState().snapshot?.tracks[0];
    useStore.setState({ selectedTrackId: t?.id ?? null, lastError: null });
  });

  it("surfaces a clear error and does NOT start recording when arm is a graceful no-op (applied:false)", async () => {
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (command === "arm_track")
          return { ok: true, command, data: { armed: true, applied: false, reason: "no input device" } };
        return orig(command, args);
      });

    await useStore.getState().enterRecord();

    const s = useStore.getState();
    expect(s.lastError).toBeTruthy();
    expect(String(s.lastError).toLowerCase()).toMatch(/input|mic|permission/);
    // The doomed record was never started.
    expect(s.snapshot?.transport.recording ?? false).toBe(false);

    spy.mockRestore();
  });

  it("surfaces a clear error when arm_track fails outright (ok:false)", async () => {
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (command === "arm_track")
          return { ok: false, command, error: "input device rejected" };
        return orig(command, args);
      });

    await useStore.getState().enterRecord();

    const s = useStore.getState();
    expect(s.lastError).toBeTruthy();
    expect(String(s.lastError).toLowerCase()).toMatch(/input|mic|permission/);
    expect(s.snapshot?.transport.recording ?? false).toBe(false);

    spy.mockRestore();
  });

  it("clears any stale error and starts recording when the arm succeeds", async () => {
    useStore.setState({ lastError: "stale no-input error from a previous attempt" });

    await useStore.getState().enterRecord();

    const s = useStore.getState();
    expect(s.lastError).toBeNull();
    expect(s.snapshot?.transport.recording ?? false).toBe(true);
  });

  it("does not start recording from a malformed arm success", async () => {
    const orig = useStore.getState().exec;
    const spy = vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<CommandResult> =>
        command === "arm_track" ? { ok: true, command, data: {} } : orig(command, args),
    );

    await useStore.getState().enterRecord();

    expect(useStore.getState().lastError).toMatch(/input/i);
    expect(useStore.getState().snapshot?.transport.recording ?? false).toBe(false);
    spy.mockRestore();
  });

  it("does not accept a transport response that failed to enter recording", async () => {
    const orig = useStore.getState().exec;
    const spy = vi.spyOn(useStore.getState(), "exec").mockImplementation(
      async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (command === "set_transport" && args?.action === "record")
          return { ok: true, command, data: { recording: false } };
        return orig(command, args);
      },
    );

    await useStore.getState().enterRecord();

    expect(useStore.getState().lastError).toBe("Could not start recording.");
    expect(useStore.getState().snapshot?.transport.recording ?? false).toBe(false);
    spy.mockRestore();
  });
});
