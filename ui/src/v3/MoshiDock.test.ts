import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCK_HELLO, MoshiDock, dockGreetingReply, recordingDisablesDock } from "./MoshiDock";
import { useStore } from "../store";
import { nativeMenuPresent, requestMicrophonePermission } from "../bridge";
import { runStudioSkillV1 } from "../agent/skillFoundry/runtime";
import { loopAllowed, runLoopTask } from "../agent/loop/runTask";
import { useTaskStore, type TaskView } from "../agent/loop/taskStore";
import { useProducerRack } from "../agent/loop/producerRack";
import type { ChangeSet } from "../agent/executor";
import { __resetMockForTests } from "../bridge.mock";

vi.mock("../vendor/moshi.js", () => ({}));
vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    brainRuntimeStatus: async () => ({ state: "unavailable" }),
    onEvent: () => () => {},
    requestMicrophonePermission: vi.fn(),
    nativeMenuPresent: vi.fn(() => false),
  };
});
// Pass-through spies, so a test can prove a path was NOT taken (or make it fail once).
vi.mock("../agent/skillFoundry/runtime", async () => {
  const actual = await vi.importActual<typeof import("../agent/skillFoundry/runtime")>("../agent/skillFoundry/runtime");
  return { ...actual, runStudioSkillV1: vi.fn(actual.runStudioSkillV1) };
});
vi.mock("../agent/loop/runTask", async () => {
  const actual = await vi.importActual<typeof import("../agent/loop/runTask")>("../agent/loop/runTask");
  return { ...actual, runLoopTask: vi.fn(actual.runLoopTask) };
});

const requestMic = vi.mocked(requestMicrophonePermission);
const originalExec = useStore.getState().exec;

/** Type into the React-controlled dock field and press Send. */
async function ask(host: HTMLElement, text: string): Promise<void> {
  const field = host.querySelector<HTMLInputElement>('[data-testid="v3-moshi-field"]');
  if (!field) throw new Error("dock field is missing");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = host.querySelector<HTMLButtonElement>('[data-testid="v3-moshi-send"]');
  if (!send || send.disabled) throw new Error("Send is not enabled");
  await act(async () => {
    send.click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const liveTask = (over: Partial<TaskView> = {}): TaskView => ({
  ask: "build me a lofi sketch",
  phase: "stepping",
  plan: [{ goal: "drums" }, { goal: "keys" }],
  steps: [{ goal: "drums", commands: [], results: [], running: true }],
  startedAt: Date.now() - 12_000,
  ...over,
});

describe("v3 Moshi dock", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      agentBusy: false,
      celebrateTick: 0,
      agentChangeSet: null,
      transport: { playing: false, recording: false, position: 0, looping: false } as never,
      setAgentBusy: vi.fn(),
      setAgentChangeSet: vi.fn(),
      pushAgentUtter: vi.fn(),
    });
    useTaskStore.setState({ current: null, signal: null });
    useProducerRack.setState({ rack: null });
    vi.mocked(nativeMenuPresent).mockReturnValue(false);
    vi.mocked(runStudioSkillV1).mockClear();
    vi.mocked(runLoopTask).mockClear();
    requestMic.mockReset();
    requestMic.mockResolvedValue({ status: "granted" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ exec: originalExec, snapshot: null });
    useTaskStore.setState({ current: null, signal: null });
    useProducerRack.setState({ rack: null });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  const mount = async () => {
    await act(async () => {
      root.render(React.createElement(MoshiDock));
      await Promise.resolve();
    });
  };

  it("recording disables the dock", async () => {
    expect(recordingDisablesDock(true)).toBe(true);
    expect(recordingDisablesDock(false)).toBe(false);
    useStore.setState({ transport: { playing: false, recording: true, position: 0, looping: false } as never });
    await mount();
    const dock = host.querySelector('[data-testid="v3-moshi-dock"]');
    expect(dock?.getAttribute("data-recording-safe")).toBe("true");
    expect(host.querySelector<HTMLInputElement>('[data-testid="v3-moshi-field"]')?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="v3-receipt"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-moshi-mic"]')?.disabled).toBe(true);
  });

  it("does not request the microphone on idle mount, and keeps the mic enabled", async () => {
    await mount();
    expect(requestMic).not.toHaveBeenCalled();
    const mic = host.querySelector<HTMLButtonElement>('[data-testid="v3-moshi-mic"]');
    expect(mic?.disabled).toBe(false);
  });

  it("requests the microphone only after tap-to-talk", async () => {
    await mount();
    const mic = host.querySelector<HTMLButtonElement>('[data-testid="v3-moshi-mic"]');
    if (!mic) throw new Error("v3 mic is missing");
    await act(async () => {
      mic.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      mic.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      await Promise.resolve();
    });
    expect(requestMic).toHaveBeenCalledOnce();
  });

  // ── demo readiness (2026-09-23) ───────────────────────────────────────────────────

  it("A4: a new ask clears the stale receipt and shows the new reply", async () => {
    const exec = vi.fn(async (command: string) => ({ ok: true, command, data: { issueId: "ISSUE-7" } }));
    useStore.setState({
      agentChangeSet: { label: "tempo", entries: [{ summary: "90 bpm" }], applied: 1 } as unknown as ChangeSet,
      setAgentChangeSet: (cs) => useStore.setState({ agentChangeSet: cs }),
      exec: exec as never,
    });
    await mount();
    expect(host.querySelector('[data-testid="v3-receipt"]')?.textContent).toContain("90 bpm");   // the stale receipt is there first

    // A local, deterministic path that sets no change set of its own (the issue route).
    await ask(host, "report a bug the fader sticks");

    expect(exec).toHaveBeenCalledWith("report_issue", expect.objectContaining({ description: "the fader sticks" }));
    expect(host.querySelector('[data-testid="v3-receipt"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-moshi-dock"]')?.textContent).toContain("logged ISSUE-7 locally");
  });

  it("A5: the V3 dock never mounts the Producer rack setup, even with the loop enabled", async () => {
    vi.stubEnv("VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP", "1");
    expect(loopAllowed()).toBe(true);   // the old mount condition holds, so absence is the fix
    await mount();
    expect(host.querySelector('[data-testid="v3-moshi-field"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="producer-rack-setup"]')).toBeNull();
    expect(host.textContent).not.toMatch(/producer rack/i);
  });

  it("A6: the packaged app (native menu present) shows no mic button; the dev lane keeps it", async () => {
    vi.mocked(nativeMenuPresent).mockReturnValue(true);
    await mount();
    expect(host.querySelector('[data-testid="v3-moshi-field"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v3-moshi-mic"]')).toBeNull();

    vi.mocked(nativeMenuPresent).mockReturnValue(false);
    act(() => root.unmount());
    root = createRoot(host);
    await mount();
    expect(host.querySelector('[data-testid="v3-moshi-mic"]')).not.toBeNull();
  });

  it("A7: a live task shows step i/N with a ticking elapsed time, and Stop flips the task's abort signal", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    await mount();
    expect(host.querySelector('[data-testid="v3-moshi-task"]')).toBeNull();

    const signal = { aborted: false };
    act(() => useTaskStore.setState({ current: liveTask({ startedAt: Date.now() - 12_000 }), signal }));
    const line = () => host.querySelector('[data-testid="v3-moshi-task"]');
    expect(line()?.getAttribute("role")).toBe("status");
    expect(line()?.textContent).toContain("Working · step 1/2 · 0:12");

    act(() => { vi.advanceTimersByTime(3_000); });
    expect(line()?.textContent).toContain("0:15");

    // more steps than the plan (a repair): N follows max(plan, steps)
    act(() => useTaskStore.setState({ current: liveTask({
      startedAt: Date.now() - 15_000,
      steps: [
        { goal: "drums", commands: [], results: [], running: false },
        { goal: "keys", commands: [], results: [], running: false },
        { goal: "repair", commands: [], results: [], running: true },
      ],
    }) }));
    expect(line()?.textContent).toContain("step 3/3");

    const stop = host.querySelector<HTMLButtonElement>('[data-testid="v3-moshi-stop"]');
    if (!stop) throw new Error("Stop is missing");
    await act(async () => { stop.click(); });
    expect(signal.aborted).toBe(true);
    expect(line()?.textContent).toContain("Stopping after this step…");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-moshi-stop"]')?.disabled).toBe(true);

    // still stopping while the step finishes (another progress event re-renders)
    act(() => useTaskStore.setState({ current: liveTask({ startedAt: Date.now() - 16_000, phase: "finalizing" }) }));
    expect(line()?.textContent).toContain("Stopping after this step…");

    act(() => useTaskStore.setState({ current: null, signal: null }));
    expect(line()).toBeNull();

    // the next task starts un-stopped
    act(() => useTaskStore.setState({ current: liveTask(), signal: { aborted: false } }));
    expect(line()?.textContent).toContain("Working");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-moshi-stop"]')?.disabled).toBe(false);
  });

  it("A7: the planning phase reads as planning, not step 0/0", async () => {
    await mount();
    act(() => useTaskStore.setState({ current: liveTask({ phase: "planning", plan: [], steps: [], startedAt: Date.now() - 3_000 }), signal: { aborted: false } }));
    const text = host.querySelector('[data-testid="v3-moshi-task"]')?.textContent ?? "";
    expect(text).toContain("Working · planning · 0:03");
    expect(text).not.toContain("0/0");
  });

  it("A7: a loop task that throws does not leave the dock stuck on Working", async () => {
    vi.stubEnv("VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP", "1");
    // The Producer-rack route sends the ask straight to runLoopTask.
    useProducerRack.setState({ rack: { projectId: "p", leadTrackId: "a", roomTrackId: "b", pluginIndex: 0 } });
    vi.mocked(runLoopTask).mockImplementationOnce(async (text) => {
      useTaskStore.getState().begin(text);
      throw new Error("snapshot read failed");
    });
    await mount();
    await ask(host, "make it warmer");
    expect(runLoopTask).toHaveBeenCalledOnce();
    expect(useTaskStore.getState().current).toBeNull();
    expect(host.querySelector('[data-testid="v3-moshi-task"]')).toBeNull();
  });

  it("A8: a greeting gets a local, deterministic reply and never reaches the skill or the engine", async () => {
    const exec = vi.fn(async (command: string) => ({ ok: true, command }));
    useStore.setState({ exec: exec as never });
    await mount();
    await ask(host, "hey moshi!");
    const text = host.querySelector('[data-testid="v3-moshi-dock"]')?.textContent ?? "";
    expect(text).toContain("set the tempo to 90");
    expect(text).toContain("turn the drums down 3 dB");
    expect(text).not.toContain("lofi sketch");
    expect(runStudioSkillV1).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();

    await ask(host, "what can you do?");
    expect(host.querySelector('[data-testid="v3-moshi-dock"]')?.textContent).toContain("set the tempo to 90");
    expect(runStudioSkillV1).not.toHaveBeenCalled();
  });

  it("A8: the greeting match is anchored — a real ask with a greeting in front is not swallowed", () => {
    for (const hi of ["hi", "Hey", "hello moshi", "yo, moshi!", "hiya.", "help", "what can you do?", "What do you do"])
      expect(dockGreetingReply(hi), hi).toBe(DOCK_HELLO);
    for (const real of ["hey moshi make the drums louder", "hi-hat louder", "help me mix", "set the tempo to 90", "yo turn it up"])
      expect(dockGreetingReply(real), real).toBeNull();
  });

  it("A9 scope: the dock field opts in to owning ⌘Z/⌘X/⌘C/⌘V from the native menu", async () => {
    await mount();
    expect(host.querySelector('[data-testid="v3-moshi-field"]')?.hasAttribute("data-owns-edit-keys")).toBe(true);
  });

  // ── demo readiness round 2 (2026-09-23) ────────────────────────────────────────────
  // D2: the receipt's Undo is a plain `undo`, so it is honest only while the receipt's own
  // batch is the undo head. In the real app "Set tempo to 90 BPM / Undo" stayed up after
  // + Drum beat and a fader move, and its Undo would have reverted the fader instead.

  const tempoReceipt = (): ChangeSet => ({
    label: "set the tempo to 90",
    applied: 1,
    entries: [{ index: 0, command: "set_tempo", summary: "Set tempo to 90 BPM", ok: true }],
  });
  const receipt = () => host.querySelector('[data-testid="v3-receipt"]');
  // The REAL store exec over the dev mock — the one funnel every toolbar, fader and key uses.
  const manual = async (command: string, args: Record<string, unknown> = {}) => {
    let ok = false;
    await act(async () => { ok = (await useStore.getState().exec(command, args)).ok; });
    return ok;
  };

  it("D2: a later manual undoable edit retires the receipt; transport and preferences do not", async () => {
    __resetMockForTests();
    useStore.setState({
      agentChangeSet: tempoReceipt(),
      setAgentChangeSet: (cs) => useStore.setState({ agentChangeSet: cs }),
    });
    await mount();
    expect(receipt()?.textContent).toContain("Set tempo to 90 BPM");

    // Play, the click and a failed edit leave the undo head on the receipt's batch.
    expect(await manual("set_transport", { playing: true })).toBe(true);
    expect(await manual("set_metronome", { enabled: true })).toBe(true);
    expect(await manual("add_drum_pattern", { pattern: "" })).toBe(false);
    expect(receipt()?.textContent).toContain("Set tempo to 90 BPM");

    // + Drum beat: the head moves past the receipt's batch, so the receipt goes.
    expect(await manual("add_drum_pattern", { pattern: "kick: x...x...x...x..." })).toBe(true);
    expect(receipt()).toBeNull();
    expect(useStore.getState().agentChangeSet).toBeNull();
  });

  it("D2: a fader move retires it too", async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    const trackId = useStore.getState().snapshot!.tracks[0].id;
    useStore.setState({ agentChangeSet: tempoReceipt(), setAgentChangeSet: (cs) => useStore.setState({ agentChangeSet: cs }) });
    await mount();
    expect(receipt()).not.toBeNull();
    expect(await manual("set_track_volume", { trackId, db: -3 })).toBe(true);
    expect(receipt()).toBeNull();
  });

  it("D2: the reply caption that came with the receipt retires with it; a new ask's reply is kept", async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    useStore.setState({
      setAgentChangeSet: (cs) => useStore.setState({ agentChangeSet: cs }),
      setAgentBusy: (b) => useStore.setState({ agentBusy: b }),
    });
    await mount();
    const dock = () => host.querySelector('[data-testid="v3-moshi-dock"]')?.textContent ?? "";

    await ask(host, "set the tempo to 90");   // the fast path: a caption plus a receipt
    expect(useStore.getState().snapshot?.session.tempo).toBe(90);
    expect(receipt()?.textContent).toContain("Set tempo to 90 BPM");

    expect(await manual("add_drum_pattern", { pattern: "kick: x...x...x...x..." })).toBe(true);
    expect(receipt()).toBeNull();
    expect(dock()).not.toMatch(/90 bpm/i);   // no leftover caption standing in for the receipt

    // A new ask retires the receipt through the same store path; its own reply must survive.
    await ask(host, "set the tempo to 92");
    expect(receipt()?.textContent).toContain("92");
    await ask(host, "hey moshi");
    expect(receipt()).toBeNull();
    expect(dock()).toContain(DOCK_HELLO);
  });

  it("D2: a manual ⌘Z retires it (the receipt's batch may be what was just undone)", async () => {
    __resetMockForTests();
    useStore.setState({ agentChangeSet: tempoReceipt(), setAgentChangeSet: (cs) => useStore.setState({ agentChangeSet: cs }) });
    await mount();
    expect(receipt()).not.toBeNull();
    expect(await manual("undo")).toBe(true);
    expect(receipt()).toBeNull();
  });
});
