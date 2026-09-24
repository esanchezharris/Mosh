// Demo readiness round 2, D1 — the crash-recovery notice in the V3 shell.
//
// After an unclean exit the real app listed every orphan take the crash left on disk inline,
// each with Recover take / Set aside, in the red error strip: 15 takes made a four-line red
// block that pushed the timeline down (task-evidence 2026-09-23 real-app-walkthrough, 11).
// V3 now shows one calm line and a collapsed "N older recordings are still on disk"
// disclosure that expands to the SAME per-take actions. Other shells keep the inline list.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryNotice } from "./RecoveryNotice";
import { useStore } from "../store";
import type { RecordingResidueEntry, Snapshot } from "../types";

const originalExec = useStore.getState().exec;
const originalRefresh = useStore.getState().refresh;

function residue(count: number): RecordingResidueEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    file: `/Users/x/Library/Mosh/session/takes/Audio_Take_${i + 1}.wav`,
    name: `Audio_Take_${i + 1}.wav`,
    trackName: "Audio",
    take: i + 1,
    readable: true,
    seconds: 2.5 + i,
    sampleRate: 48000,
    startSeconds: 0,
    decision: "adopt" as const,
  }));
}

function crashSnapshot(takes: number, recoverableCount = 2): Snapshot {
  return {
    schemaVersion: 1,
    session: { recoveryAvailable: true, recoverableCount, recordingResidue: residue(takes) },
    tracks: [],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  } as unknown as Snapshot;
}

describe("D1: the V3 crash-recovery notice is one calm line", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string) => ({ ok: true, command }));
    useStore.setState({
      snapshot: crashSnapshot(15),
      recoveryDismissed: false,
      exec: exec as never,
      refresh: vi.fn(async () => {}) as never,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ exec: originalExec, refresh: originalRefresh, snapshot: null, recoveryDismissed: false });
  });

  const render = async (compact: boolean) => {
    await act(async () => {
      root.render(React.createElement(RecoveryNotice, { compact }));
      await Promise.resolve();
    });
  };
  const q = (id: string) => host.querySelectorAll(`[data-testid="${id}"]`);

  it("15 orphan takes: one summary line and a collapsed disclosure, no per-take buttons", async () => {
    await render(true);
    const notice = host.querySelector('[data-testid="recovery-notice"]');
    expect(notice).not.toBeNull();
    // The takes are behind a closed disclosure — not one of them, nor its buttons, is rendered.
    expect(q("recovery-residue-item")).toHaveLength(0);
    expect(q("recovery-residue-adopt")).toHaveLength(0);
    expect(q("recovery-residue-quarantine")).toHaveLength(0);
    expect(notice!.textContent).not.toContain("Audio_Take_1.wav");
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="recovery-residue-toggle"]');
    expect(toggle?.textContent).toContain("15 older recordings are still on disk");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    // Calm, not the red error strip.
    expect(notice!.classList.contains("error-bar")).toBe(false);
    expect(notice!.textContent).toContain("Restored from the last auto-save");
    // The unsaved-changes Recover action stays on the line.
    expect(q("recovery-recover")).toHaveLength(1);
  });

  it("expanding the disclosure reaches every per-take action; nothing is acted on by itself", async () => {
    await render(true);
    expect(exec).not.toHaveBeenCalled();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="recovery-residue-toggle"]')!;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(q("recovery-residue-item")).toHaveLength(15);
    expect(q("recovery-residue-adopt")).toHaveLength(15);
    expect(q("recovery-residue-quarantine")).toHaveLength(15);
    expect(exec).not.toHaveBeenCalled();   // opening the list decides nothing

    await act(async () => { (q("recovery-residue-quarantine")[3] as HTMLButtonElement).click(); });
    expect(exec).toHaveBeenCalledWith("quarantine_recording_residue", { file: residue(15)[3].file });
    await act(async () => { (q("recovery-residue-adopt")[0] as HTMLButtonElement).click(); });
    expect(exec).toHaveBeenCalledWith("adopt_recording_residue", { file: residue(15)[0].file });

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(q("recovery-residue-item")).toHaveLength(0);
  });

  // Round-2 review nit: aria-controls named a list that only exists while open, so a screen
  // reader was pointed at nothing while it was collapsed. It is set only while the list exists.
  it("the disclosure's aria-controls never names a missing element", async () => {
    await render(true);
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="recovery-residue-toggle"]')!;
    const controls = () => toggle.getAttribute("aria-controls");
    expect(controls(), "collapsed: nothing to point at").toBeNull();
    await act(async () => { toggle.click(); });
    expect(controls()).toBe("v3-recovery-residue");
    expect(document.getElementById(controls()!)).toBe(host.querySelector('[data-testid="recovery-residue"]'));
    await act(async () => { toggle.click(); });
    expect(controls()).toBeNull();
  });

  it("one take reads singular; no takes means no disclosure", async () => {
    useStore.setState({ snapshot: crashSnapshot(1) });
    await render(true);
    expect(host.querySelector('[data-testid="recovery-residue-toggle"]')?.textContent)
      .toContain("1 older recording is still on disk");

    useStore.setState({ snapshot: crashSnapshot(0, 0) });
    await render(true);
    expect(host.querySelector('[data-testid="recovery-notice"]')?.textContent).toContain("Restored from the last auto-save");
    expect(q("recovery-residue-toggle")).toHaveLength(0);
    expect(q("recovery-recover")).toHaveLength(0);   // nothing to replay, so no Recover
  });

  it("Recover and Dismiss keep their commands", async () => {
    await render(true);
    await act(async () => { (q("recovery-recover")[0] as HTMLButtonElement).click(); });
    expect(exec).toHaveBeenCalledWith("recover_session", {});
    expect(useStore.getState().recoveryDismissed).toBe(true);

    useStore.setState({ recoveryDismissed: false });
    await render(true);
    await act(async () => { (q("recovery-dismiss")[0] as HTMLButtonElement).click(); });
    expect(exec).toHaveBeenCalledWith("discard_recovery", {});
    expect(useStore.getState().recoveryDismissed).toBe(true);
  });

  it("other shells keep the full inline list in the error strip", async () => {
    await render(false);
    const notice = host.querySelector('[data-testid="recovery-notice"]');
    expect(notice!.classList.contains("error-bar")).toBe(true);
    expect(q("recovery-residue-item")).toHaveLength(15);
    expect(q("recovery-residue-quarantine")).toHaveLength(15);
    expect(q("recovery-residue-toggle")).toHaveLength(0);
  });
});
