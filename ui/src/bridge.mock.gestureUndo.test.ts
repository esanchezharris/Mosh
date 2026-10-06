// A panel drag is ONE undo step, as the engine makes it (MoshOps::joinGestureTxn): every
// set_plugin_param / set_plugin_state of one drag carries the same `gesture` id, and the
// calls after the first join the step the first one opened. Without a gesture each call is
// its own step. The window ends at any other command that is not a read (undo included),
// after 3 s idle, and inside a batch. The panels' coalescing is only testable against the
// mock if the mock keeps these rules, so they are pinned here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Plugin, Snapshot } from "./types";

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const snapshot = () => mockSnapshot<Snapshot>();

let trackId = "";
let index = 0;
const synth = async (): Promise<Plugin> => (await snapshot()).tracks.find((t) => t.id === trackId)!.plugins!.find((p) => p.type === "4osc")!;
const paramIndexOf = async (id: string) => (await synth()).params.find((p) => p.id === id)!.index;
const valueOf = async (id: string) => (await synth()).params.find((p) => p.id === id)!.value;
const setParam = (paramIndex: number, value: number, gesture?: string) =>
  run("set_plugin_param", { trackId, index, paramIndex, value, ...(gesture === undefined ? {} : { gesture }) });
const setState = (key: string, value: unknown, gesture?: string) =>
  run("set_plugin_state", { trackId, index, key, value, ...(gesture === undefined ? {} : { gesture }) });
const undo = async () => (await run("undo")).data as { undone: boolean };
const commandLog = async () =>
  ((await run("get_command_log", { limit: 50 })).data as { entries: { command: string; undoable: boolean }[] }).entries;

beforeEach(async () => {
  __resetMockForTests();
  trackId = (await snapshot()).tracks[1]!.id;          // Bass: a MIDI track
  expect((await run("load_builtin", { trackId, type: "4osc" })).ok).toBe(true);
  index = (await synth()).index;
});
afterEach(() => vi.useRealTimers());

describe("set_plugin_param undo, as the engine makes it", () => {
  it("one drag with one gesture id is one undo step, across several parameters", async () => {
    const level1 = await paramIndexOf("level1");
    const attack = await paramIndexOf("ampAttack");
    const [l0, a0] = [await valueOf("level1"), await valueOf("ampAttack")];
    for (const v of [0.6, 0.55, 0.5, 0.45]) {
      expect((await setParam(level1, v, "ui-test-1")).ok).toBe(true);
      expect((await setParam(attack, 1 - v, "ui-test-1")).ok).toBe(true);
    }
    expect(await valueOf("level1")).toBeCloseTo(0.45, 6);

    expect((await undo()).undone).toBe(true);                       // the whole drag
    expect(await valueOf("level1")).toBe(l0);
    expect(await valueOf("ampAttack")).toBe(a0);
    expect((await undo()).undone).toBe(true);                       // the next step back is the insert
    expect((await snapshot()).tracks.find((t) => t.id === trackId)!.plugins!.some((p) => p.type === "4osc")).toBe(false);
  });

  it("without a gesture every call is its own step", async () => {
    const level1 = await paramIndexOf("level1");
    const l0 = await valueOf("level1");
    await setParam(level1, 0.7);
    await setParam(level1, 0.6);
    await undo();
    expect(await valueOf("level1")).toBeCloseTo(0.7, 6);
    await undo();
    expect(await valueOf("level1")).toBe(l0);
  });

  it("preset load, then a drag, then undo: the drag is undone and the preset stays", async () => {
    const level1 = await paramIndexOf("level1");
    expect((await run("load_preset", { trackId, index, file: "/presets/4osc/mosh-bass.json" })).ok).toBe(true);
    const preset = await valueOf("level1");
    for (const v of [0.5, 0.4, 0.3]) await setParam(level1, v, "ui-test-2");
    expect(await valueOf("level1")).toBeCloseTo(0.3, 6);
    await undo();
    expect(await valueOf("level1")).toBe(preset);
    expect(await valueOf("ampRelease")).toBeCloseTo(0.18, 6);       // the rest of mosh-bass is still on
    await undo();                                                    // and the next undo is the preset
    expect(await valueOf("ampRelease")).not.toBeCloseTo(0.18, 6);
  });

  it("another edit between two calls of one gesture ends its step; a read does not", async () => {
    const level1 = await paramIndexOf("level1");
    const l0 = await valueOf("level1");
    await setParam(level1, 0.6, "ui-test-3");
    await run("list_builtins");                                     // a read keeps the window
    await run("get_command_log");
    await setParam(level1, 0.5, "ui-test-3");
    await run("set_track_volume", { trackId, db: -3 });             // an edit ends it
    await setParam(level1, 0.4, "ui-test-3");                       // a new step, same id

    await undo();
    expect(await valueOf("level1")).toBeCloseTo(0.5, 6);
    await undo();                                                    // the volume
    expect(await valueOf("level1")).toBeCloseTo(0.5, 6);
    await undo();                                                    // both calls before the volume, as one
    expect(await valueOf("level1")).toBe(l0);
  });

  it("a command that opens no step of its own still ends the window (the engine closes the step there)", async () => {
    const level1 = await paramIndexOf("level1");
    await setParam(level1, 0.6, "ui-test-9");
    expect((await run("arm_track", { trackId, armed: true })).ok).toBe(true);   // not undoable
    await setParam(level1, 0.5, "ui-test-9");
    await undo();
    expect(await valueOf("level1")).toBeCloseTo(0.6, 6);
  });

  it("an undo ends the window: the gesture's next call is a new step, and the redo is gone", async () => {
    const level1 = await paramIndexOf("level1");
    const l0 = await valueOf("level1");
    await setParam(level1, 0.6, "ui-test-4");
    await undo();
    expect(await valueOf("level1")).toBe(l0);
    await setParam(level1, 0.5, "ui-test-4");
    expect((await run("redo")).data).toEqual({ redone: false });
    await undo();
    expect(await valueOf("level1")).toBe(l0);
  });

  it("a drag idle for more than 3 s ends its step", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const level1 = await paramIndexOf("level1");
    await setParam(level1, 0.6, "ui-test-5");
    vi.setSystemTime(1_000_000 + 2_900);
    await setParam(level1, 0.55, "ui-test-5");                      // 2.9 s after the last call: joins
    vi.setSystemTime(1_000_000 + 2_900 + 3_100);
    await setParam(level1, 0.5, "ui-test-5");                       // 3.1 s idle: a new step
    await undo();
    expect(await valueOf("level1")).toBeCloseTo(0.55, 6);
  });

  it("inside a batch the batch is the one step; after it the same gesture opens a new one", async () => {
    const level1 = await paramIndexOf("level1");
    const l0 = await valueOf("level1");
    await run("batch_begin");
    await setParam(level1, 0.6, "ui-test-6");
    await setParam(level1, 0.5, "ui-test-6");
    await run("batch_end");
    await setParam(level1, 0.4, "ui-test-6");
    await undo();
    expect(await valueOf("level1")).toBeCloseTo(0.5, 6);
    await undo();
    expect(await valueOf("level1")).toBe(l0);
  });

  it("logs set_plugin_param as undoable, and refuses a bad gesture or parameter without a step", async () => {
    const level1 = await paramIndexOf("level1");
    await setParam(level1, 0.6);
    expect((await commandLog())[0]).toMatchObject({ command: "set_plugin_param", undoable: true });
    const before = await valueOf("level1");
    for (const bad of ["", "has space", "x".repeat(65)]) {
      const r = await setParam(level1, 0.1, bad);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/bad gesture/);
    }
    expect((await setParam(level1, 0.1, 7 as unknown as string)).ok).toBe(false);
    expect((await setParam(999, 0.1)).error).toMatch(/bad paramIndex/);
    expect(await valueOf("level1")).toBe(before);
    await undo();                                                    // the one good call
    await undo();                                                    // then the insert: nothing was added between
    expect((await snapshot()).tracks.find((t) => t.id === trackId)!.plugins!.some((p) => p.type === "4osc")).toBe(false);
  });
});

describe("set_plugin_state undo, as the engine makes it", () => {
  it("a setting drag shares its step with a parameter of the same gesture", async () => {
    const level1 = await paramIndexOf("level1");
    const l0 = await valueOf("level1");
    const d0 = (await synth()).state!.delayBeats!.value;
    await setState("delayBeats", 0.5, "ui-test-7");
    await setParam(level1, 0.6, "ui-test-7");
    await setState("delayBeats", 0.75, "ui-test-7");
    await undo();
    expect((await synth()).state!.delayBeats!.value).toBe(d0);
    expect(await valueOf("level1")).toBe(l0);
  });

  it("the value it already has is no step, is logged undoable:false, and keeps an open drag's window", async () => {
    const level1 = await paramIndexOf("level1");
    const l0 = await valueOf("level1");
    const type0 = (await synth()).state!.filterType!.value;
    await setParam(level1, 0.6, "ui-test-8");
    expect((await setState("filterType", type0)).ok).toBe(true);    // no change: not an edit
    expect((await commandLog())[0]).toMatchObject({ command: "set_plugin_state", undoable: false });
    await setParam(level1, 0.5, "ui-test-8");                       // still the same step
    await undo();
    expect(await valueOf("level1")).toBe(l0);
    expect((await synth()).state!.filterType!.value).toBe(type0);
  });
});
