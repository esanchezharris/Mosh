// N1 regression guard — init() must NEVER issue a command that reaches the native
// jobManager.ensureServiceRunning() (MoshOps.cpp): list_colors / list_transform_targets /
// list_loras are the generative-service-dependent list commands, and ensureServiceRunning()
// can SYNCHRONOUSLY spawn the Python service and block on its /health handshake.
// WebBridge.cpp's execute_command native binding resolves inline on the message thread
// (unlike brain_chat, which is Thread::launch'd off it) — so firing one of these from
// init() would freeze the UI on EVERY app launch (worse under MOSH_ENABLE_SA3=1, which
// pulls in the MLX import). This was invisible to vitest/e2e because the in-memory mock
// resolves instantly; this file asserts the STRUCTURAL invariant instead: spy on the
// bridge's executeCommand call log and prove init() never calls a service-spawning list
// command, while the lazy loadCapabilities() trigger (fired from a clip-menu open or a
// Gen-drawer mount — a user interaction, after the app is already up) still works.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", async () => {
  const actual = await vi.importActual<typeof import("./bridge")>("./bridge");
  return { ...actual, executeCommand: vi.fn(actual.executeCommand) };
});

import { executeCommand } from "./bridge";
import { useStore } from "./store";
import { __resetMockForTests } from "./bridge.mock";

const SERVICE_SPAWNING_COMMANDS = ["list_colors", "list_transform_targets", "list_loras"];

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const commandsSeen = (): string[] =>
  vi.mocked(executeCommand).mock.calls.map(([req]) => (req as { command: string }).command);

describe("init() never eagerly spawns the generative service", () => {
  afterEach(() => {
    vi.mocked(executeCommand).mockClear();
  });

  it("runs once and issues no service-spawning list command when init is replayed", async () => {
    __resetMockForTests();
    useStore.setState({ capabilities: null, availableColors: [], availableTransformTargets: [], availableLoras: [] });

    useStore.getState().init();
    useStore.getState().init(); // React.StrictMode replays the owning App effect in dev.
    // Drain whatever init() kicked off synchronously (refresh / refreshRemote /
    // enable_all_meters) — several ticks, since these chain through async handlers.
    await flush(); await flush(); await flush();

    const spawning = commandsSeen().filter((c) => SERVICE_SPAWNING_COMMANDS.includes(c));
    expect(spawning).toEqual([]);
    // Sanity: init() DID run (not a vacuously-passing empty call log) — enable_all_meters
    // is the one command init() unconditionally issues.
    expect(commandsSeen()).toContain("enable_all_meters");
    expect(commandsSeen().filter((c) => c === "enable_all_meters")).toHaveLength(1);
  });

  it("the lazy loadCapabilities() trigger (clip-menu / Gen-drawer open) still resolves it", async () => {
    __resetMockForTests();
    useStore.setState({ capabilities: null });

    useStore.getState().loadCapabilities();
    await flush();

    expect(commandsSeen()).toContain("list_transform_targets");
    expect(useStore.getState().capabilities).not.toBeNull();
  });

  it("loadCapabilities() is a no-op once already resolved (no duplicate service call)", async () => {
    __resetMockForTests();
    useStore.setState({ capabilities: { transcribe: true, skeleton: true, whisper: true, phonology: true, transformReal: true, trainingBackend: "fake" } });

    useStore.getState().loadCapabilities();
    await flush();

    expect(commandsSeen()).toEqual([]);
  });
});
