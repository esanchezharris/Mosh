import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { __resetMockForTests, mockSnapshot } from "../../bridge.mock";
import { useStore } from "../../store";
import type { CommandResult, Plugin, Snapshot, Track } from "../../types";
import type { NativeExecution } from "./nativeTask";
import { useProducerRack } from "./producerRack";
import { useTaskStore } from "./taskStore";

const { chat, archive } = vi.hoisted(() => ({
  chat: vi.fn<(messages: readonly { role: string; content: string }[]) => Promise<{ content: string }>>(),
  archive: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../bridge", async (original) => ({
  ...await original<typeof import("../../bridge")>(), brainChat: chat, archivePair: archive, demoBrainAvailable: () => false,
}));
import { runLoopTask } from "./runTask";

const rack = { projectId: "unit-project", leadTrackId: "lead", roomTrackId: "room", pluginIndex: 3 };
const level = { command: "set_track_volume", args: { trackId: "lead", db: 3 } };
const room = { command: "set_track_volume", args: { trackId: "room", db: -6 } };
const reply = (commands = [level, room]) => ({ content: JSON.stringify({ status: "done", commands, say: "I already fixed the whole mix" }) });
const originalExec = useStore.getState().exec;
const originalRefresh = useStore.getState().refresh;
const envelopeSchema = z.object({ requestId: z.string(), projectId: z.string(), payload: z.unknown().optional() });
const commandsSchema = z.array(z.object({ command: z.string(), args: z.record(z.string(), z.unknown()) }));
const highpass: Plugin = { index: 3, name: "High-Pass", type: "highpass", enabled: false, external: false, builtin: true, isInstrument: false,
  params: [{ index: 0, name: "Frequency", value: 70 / 21990, display: "80 Hz", min: 10, max: 22000, automated: false }] };
function track(id: string, index: number): Track {
  return { id, index, name: id, type: "audio", clips: [], volumeDb: 0, automationMode: "read", plugins: id === "lead" ? [structuredClone(highpass)] : [],
    mixerPlugins: [{ index: 2, name: "Volume & Pan Plugin", type: "volume", enabled: true, external: false, isInstrument: false,
      params: [{ index: 0, name: "Volume", value: 0.740818202495575, display: "+0.00 dB", automated: false }] }] };
}
function pauseProvider() {
  let release = () => {};
  let entered = () => {};
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  chat.mockImplementationOnce(async () => { entered(); await wait; return reply(); });
  return { paused, release };
}

// This is an envelope-level unit fixture, not a native durability or audio proof.
async function fixture() {
  const seed = await mockSnapshot<Snapshot>();
  const snapshot: Snapshot = { ...seed, tracks: [track("lead", 0), track("room", 1)], trackGroups: [] };
  const records = new Map<string, { payload: string; execution: NativeExecution }>();
  const state = { revision: 0, unknownAfterApply: false };
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const exec: typeof originalExec = async (command, args = {}): Promise<CommandResult> => {
    calls.push({ command, args });
    if (command === "get_agent_context") return { ok: true, command, data: { projectId: rack.projectId, epoch: "unit-epoch", revision: state.revision, snapshot } };
    const identity = envelopeSchema.parse(args);
    const existing = records.get(identity.requestId);
    if (command === "begin_agent_request") {
      const payload = JSON.stringify(identity.payload);
      if (existing && existing.payload !== payload) return { ok: false, command, error: "request_identity_conflict" };
      if (existing) return { ok: true, command, data: { ...existing.execution, replayed: true } };
      const execution: NativeExecution = { requestId: identity.requestId, projectId: identity.projectId, status: "prepared", appliedCount: 0 };
      records.set(identity.requestId, { payload, execution });
      return { ok: true, command, data: execution };
    }
    if (!existing) throw new TypeError("Unit fixture received an unreserved request");
    if (command === "apply_agent_patch") {
      const commands = commandsSchema.parse(args.commands);
      existing.execution = { ...existing.execution, status: "committed", appliedCount: commands.length, results: commands.map((call) => ({ command: call.command, ok: true })) };
      state.revision++;
      if (state.unknownAfterApply) throw new TypeError("Unit fixture lost apply response");
      return { ok: true, command, data: existing.execution };
    }
    if (command === "get_agent_request") {
      if (state.unknownAfterApply) throw new TypeError("Unit fixture lost outcome lookup");
      return { ok: true, command, data: existing.execution };
    }
    if (command === "cancel_agent_request") {
      if (existing.execution.status === "prepared") existing.execution = { ...existing.execution, status: "cancelled" };
      return { ok: true, command, data: existing.execution };
    }
    throw new TypeError(`Unexpected native command in unit fixture: ${command}`);
  };
  useStore.setState({ snapshot, exec, refresh: async () => { useStore.setState({ snapshot }); } });
  useProducerRack.getState().setRack(rack);
  const ui = { say: vi.fn<(text: string | null) => void>(), utter: vi.fn<(intent: string, say?: string) => void>() };
  return { calls, state, records, ui, count: (command: string) => calls.filter((call) => call.command === command).length };
}

describe("Producer runLoopTask integration (native envelopes mocked)", () => {
  beforeEach(() => {
    __resetMockForTests(); chat.mockReset(); archive.mockReset(); chat.mockResolvedValue(reply());
    useTaskStore.setState({ current: null, last: null, history: [], drawerOpen: false, signal: null, sink: null });
  });
  afterEach(() => {
    useProducerRack.getState().setRack(null);
    useStore.setState({ exec: originalExec, refresh: originalRefresh });
  });

  it("joins concurrent same-ID deliveries into one provider call, apply, and history item", async () => {
    const env = await fixture();
    const pause = pauseProvider();
    const first = runLoopTask("raise vocal and lower room", env.ui, { requestId: "concurrent" });
    await pause.paused;
    const duplicate = runLoopTask("raise vocal and lower room", env.ui, { requestId: "concurrent" });
    pause.release();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(a).toBe(b);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(env.count("apply_agent_patch")).toBe(1);
    expect(useTaskStore.getState().history).toHaveLength(1);
  });

  it("rejects a changed payload while the same ID is running before another provider call", async () => {
    const env = await fixture();
    const pause = pauseProvider();
    const first = runLoopTask("first payload", env.ui, { requestId: "conflict" });
    await pause.paused;
    const conflict = await runLoopTask("different payload", env.ui, { requestId: "conflict" });
    pause.release();
    await first;
    expect(conflict.outcome).toBe("need_user");
    expect(conflict.say).toContain("identity conflicts");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(env.count("apply_agent_patch")).toBe(1);
  });

  it("rejects a changed committed payload before the provider is reinvoked", async () => {
    const env = await fixture();
    await runLoopTask("first payload", env.ui, { requestId: "durable-conflict" });
    const conflict = await runLoopTask("different payload", env.ui, { requestId: "durable-conflict" });
    expect(conflict.outcome).toBe("error");
    expect(conflict.say).toContain("identity_conflict");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(env.count("apply_agent_patch")).toBe(1);
    expect(useTaskStore.getState().history.some((task) => task.execution?.requestId === "durable-conflict" && task.execution.status === "committed")).toBe(true);
  });

  it("returns terminal replay before planning despite a changed native revision", async () => {
    const env = await fixture();
    await runLoopTask("one logical payload", env.ui, { requestId: "replay" });
    env.state.revision = 99;
    const replay = await runLoopTask("one logical payload", env.ui, { requestId: "replay" });
    expect(replay.execution?.replayed).toBe(true);
    expect(replay.say).toContain("already committed");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(env.count("apply_agent_patch")).toBe(1);
    expect(useTaskStore.getState().history).toHaveLength(1);
  });

  it("gives genuine new requests with identical wording distinct logical IDs", async () => {
    const env = await fixture();
    const first = await runLoopTask("same words", env.ui);
    const second = await runLoopTask("same words", env.ui);
    expect(first.execution?.requestId).toBeTruthy();
    expect(first.execution?.requestId).not.toBe(second.execution?.requestId);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(env.count("apply_agent_patch")).toBe(2);
    expect(useTaskStore.getState().history).toHaveLength(2);
  });

  it("rejects lead writes in the exact ordinary room revision", async () => {
    const env = await fixture();
    const run = await runLoopTask("Keep that vocal tone and level. Make the room less obvious.", env.ui, { requestId: "room-revision" });
    expect(run.outcome).toBe("need_user");
    expect(run.say).toContain("protected track");
    expect(env.count("apply_agent_patch")).toBe(0);
    expect(run.execution?.status).toBe("cancelled");
    expect(chat.mock.calls[0]?.[0][0]?.content).toContain("only the printed-room fader");
  });

  it("ignores optimistic provider text when stopped before application", async () => {
    const env = await fixture();
    const pause = pauseProvider();
    const running = runLoopTask("raise vocal", env.ui, { requestId: "cancel" });
    await pause.paused;
    useTaskStore.getState().requestStop();
    pause.release();
    const run = await running;
    expect(run.outcome).toBe("aborted");
    expect(run.say).toBe("Stopped before application; no changes were applied.");
    expect(env.ui.say).toHaveBeenLastCalledWith(run.say);
    expect(useTaskStore.getState().last?.say).toBe(run.say);
    expect(env.count("apply_agent_patch")).toBe(0);
  });

  it("does not claim zero effects when apply and outcome responses are both unavailable", async () => {
    const env = await fixture();
    env.state.unknownAfterApply = true;
    const run = await runLoopTask("raise vocal", env.ui, { requestId: "unknown" });
    expect(run.execution?.status).toBe("unresolved");
    expect(run.outcome).toBe("error");
    expect(run.say).toContain("unresolved");
    expect(run.say).not.toMatch(/no changes|before application|rolled back/i);
    expect(run.transcript[0]?.results.every((result) => result.disposition === "unconfirmed")).toBe(true);
  });

  it("uses only the one scripted provider and operational native commands without archiving or memory calls", async () => {
    const env = await fixture();
    await runLoopTask("raise vocal", env.ui, { requestId: "no-sidework" });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
    expect(env.calls.map((call) => call.command)).toEqual(["get_agent_context", "begin_agent_request", "apply_agent_patch"]);
  });
});
