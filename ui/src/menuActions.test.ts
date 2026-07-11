import { describe, it, expect, vi } from "vitest";
import { runAction, type ActionCtx, type ActionStore } from "./menuActions";

// A fake store that records exec() calls and method invocations, so we can assert
// each action fires the right MoshOps command — the contract the menus rely on.
function makeStore(over: Partial<ActionStore> = {}) {
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];
  const store: ActionStore = {
    exec: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      execCalls.push({ command, args });
      return { ok: true };
    }),
    refresh: vi.fn(async () => {}),
    copySelection: vi.fn(),
    cutSelection: vi.fn(async () => {}),
    pasteClipboard: vi.fn(async () => {}),
    clearSelection: vi.fn(),
    selection: new Set<string>(),
    transport: { playing: false, position: 1.5 },
    snapshot: null,
    clipboard: null,
    setTool: vi.fn(),
    ...over,
  };
  return { store, execCalls };
}

function makeCtx(over: Partial<ActionCtx> = {}, storeOver: Partial<ActionStore> = {}) {
  const { store, execCalls } = makeStore(storeOver);
  const ctx: ActionCtx = {
    store,
    pickFiles: vi.fn(async () => ({ ok: true, files: ["/picked/in.mosh"] })),
    pickSaveFile: vi.fn(async () => ({ ok: true, file: "/picked/out.mosh" })),
    ...over,
  };
  return { ctx, store, execCalls };
}

describe("runAction — File", () => {
  it("save → exec('save')", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("save", ctx);
    expect(execCalls).toContainEqual({ command: "save", args: undefined });
  });

  it("new_project → exec('new_project') then refresh", async () => {
    const { ctx, store, execCalls } = makeCtx();
    await runAction("new_project", ctx);
    expect(execCalls[0].command).toBe("new_project");
    expect(store.refresh).toHaveBeenCalled();
  });

  it("open_project with an explicit file (Open Recent) skips the picker", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("open_project", ctx, { file: "/recent/song.mosh" });
    expect(ctx.pickFiles).not.toHaveBeenCalled();
    expect(execCalls).toContainEqual({ command: "open_project", args: { file: "/recent/song.mosh" } });
  });

  it("open_project without a file pops the native picker, then opens the chosen path", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("open_project", ctx);
    expect(ctx.pickFiles).toHaveBeenCalled();
    expect(execCalls).toContainEqual({ command: "open_project", args: { file: "/picked/in.mosh" } });
  });

  it("open_project does nothing if the picker is cancelled", async () => {
    const { ctx, execCalls } = makeCtx({ pickFiles: vi.fn(async () => ({ ok: false, files: [] })) });
    await runAction("open_project", ctx);
    expect(execCalls.some((c) => c.command === "open_project")).toBe(false);
  });

  it("open_recent opens by recent-list index (no picker), then refreshes", async () => {
    const { ctx, store, execCalls } = makeCtx();
    await runAction("open_recent", ctx, { index: 2 });
    expect(ctx.pickFiles).not.toHaveBeenCalled();
    expect(execCalls).toContainEqual({ command: "open_recent", args: { index: 2 } });
    expect(store.refresh).toHaveBeenCalled();
  });

  it("open_recent defaults to the most-recent project (index 0) when none is given", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("open_recent", ctx);
    expect(execCalls).toContainEqual({ command: "open_recent", args: { index: 0 } });
  });

  it("save_as pops the save picker, then exec('save_as', {file})", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("save_as", ctx);
    expect(ctx.pickSaveFile).toHaveBeenCalled();
    expect(execCalls).toContainEqual({ command: "save_as", args: { file: "/picked/out.mosh" } });
  });

  it("save_as does nothing if the save picker is cancelled", async () => {
    const { ctx, execCalls } = makeCtx({ pickSaveFile: vi.fn(async () => ({ ok: false, file: "" })) });
    await runAction("save_as", ctx);
    expect(execCalls.some((c) => c.command === "save_as")).toBe(false);
  });

  it("export_audio picks a destination and exports with a format inferred from the extension", async () => {
    const { ctx, execCalls } = makeCtx({ pickSaveFile: vi.fn(async () => ({ ok: true, file: "/out/mix.aiff" })) });
    await runAction("export_audio", ctx);
    const call = execCalls.find((c) => c.command === "export_audio");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ file: "/out/mix.aiff", format: "aiff" });
  });
});

describe("runAction — Edit", () => {
  it("undo → exec('undo'), redo → exec('redo')", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("undo", ctx);
    await runAction("redo", ctx);
    expect(execCalls.map((c) => c.command)).toEqual(["undo", "redo"]);
  });

  it("copy/cut/paste route to the store clipboard helpers (UI-local selection)", async () => {
    const { ctx, store } = makeCtx();
    await runAction("copy", ctx);
    await runAction("cut", ctx);
    await runAction("paste", ctx);
    expect(store.copySelection).toHaveBeenCalled();
    expect(store.cutSelection).toHaveBeenCalled();
    expect(store.pasteClipboard).toHaveBeenCalled();
  });

  it("delete removes every selected clip then clears the selection", async () => {
    const { ctx, store, execCalls } = makeCtx({}, { selection: new Set(["c1", "c2"]) });
    await runAction("delete", ctx);
    expect(execCalls.filter((c) => c.command === "remove_clip").map((c) => c.args)).toEqual([
      { clipId: "c1" },
      { clipId: "c2" },
    ]);
    expect(store.clearSelection).toHaveBeenCalled();
  });
});

describe("runAction — transport", () => {
  it("play_pause toggles the transport", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("play_pause", ctx);
    expect(execCalls).toContainEqual({ command: "set_transport", args: { action: "toggle" } });
  });

  it("record/to_start/to_end keep their transport payloads", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("record", ctx);
    await runAction("to_start", ctx);
    await runAction("to_end", ctx);
    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
      { command: "set_transport", args: { action: "to_start" } },
      { command: "set_transport", args: { action: "to_end" } },
    ]);
  });

  it("seek and loop_region preserve ruler set_transport payloads", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("seek", ctx, { position: 2.25 });
    await runAction("loop_region", ctx, { loopStart: 1, loopEnd: 4 });
    expect(execCalls).toEqual([
      { command: "set_transport", args: { position: 2.25 } },
      { command: "set_transport", args: { loop: true, loopStart: 1, loopEnd: 4 } },
    ]);
  });
});

describe("runAction — arrangement shortcuts", () => {
  it("duplicate duplicates every selected clip", async () => {
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(["c1", "c2"]) });
    await runAction("duplicate", ctx);
    expect(execCalls).toEqual([
      { command: "duplicate_clip", args: { clipId: "c1" } },
      { command: "duplicate_clip", args: { clipId: "c2" } },
    ]);
  });

  it("group collects selected clips' track ids without grouped tracks", async () => {
    const snapshot = {
      tracks: [
        { id: "t1", isGroup: false, clips: [{ id: "c1", start: 0, length: 1 }] },
        { id: "t2", isGroup: true, clips: [{ id: "c2", start: 0, length: 1 }] },
        { id: "t3", isGroup: false, clips: [{ id: "c3", start: 0, length: 1 }] },
      ],
    } as unknown as import("./types").Snapshot;
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(["c1", "c2", "c3"]), snapshot });
    await runAction("group", ctx);
    expect(execCalls).toEqual([{ command: "create_group_track", args: { trackIds: ["t1", "t3"] } }]);
  });

  it("split only splits selected clips crossing the playhead", async () => {
    const snapshot = {
      tracks: [
        { id: "t1", isGroup: false, clips: [{ id: "c1", start: 0, length: 2 }, { id: "c2", start: 3, length: 1 }] },
      ],
    } as unknown as import("./types").Snapshot;
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(["c1", "c2"]), transport: { playing: false, position: 1 }, snapshot });
    await runAction("split", ctx);
    expect(execCalls).toEqual([{ command: "split_clip", args: { clipId: "c1", time: 1 } }]);
  });

  it("tool actions route through the store tool setter", async () => {
    const { ctx, store } = makeCtx();
    await runAction("tool_move", ctx);
    await runAction("tool_split", ctx);
    await runAction("tool_range", ctx);
    expect(store.setTool).toHaveBeenNthCalledWith(1, "move");
    expect(store.setTool).toHaveBeenNthCalledWith(2, "split");
    expect(store.setTool).toHaveBeenNthCalledWith(3, "range");
  });
});
