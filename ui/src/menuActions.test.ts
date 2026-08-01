import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAction, type ActionCtx, type ActionStore } from "./menuActions";
import { recordSessionCommand, getSessionLog, __resetSessionLogForTests } from "./agent/memory/sessionLog";
import type { Snapshot } from "./types";

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
    invalidateMemory: vi.fn(),
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

  // AGT-MEM (M3) — every action that swaps the underlying Edit must drop the cached
  // agent-memory pools, or a stale project's notes leak into the newly-opened one's
  // prompts (agent/memory/hydrate.ts's invalidateMemoryHydration).
  it("new_project / open_project / open_recent all invalidate the memory cache", async () => {
    const { ctx: newCtx, store: newStore } = makeCtx();
    await runAction("new_project", newCtx);
    expect(newStore.invalidateMemory).toHaveBeenCalledOnce();

    const { ctx: openCtx, store: openStore } = makeCtx();
    await runAction("open_project", openCtx, { file: "/recent/song.mosh" });
    expect(openStore.invalidateMemory).toHaveBeenCalledOnce();

    const { ctx: recentCtx, store: recentStore } = makeCtx();
    await runAction("open_recent", recentCtx, { index: 0 });
    expect(recentStore.invalidateMemory).toHaveBeenCalledOnce();
  });

  it("does NOT invalidate memory when open_project's picker is cancelled (no real switch happened)", async () => {
    const { ctx, store } = makeCtx({ pickFiles: vi.fn(async () => ({ ok: false, files: [] })) });
    await runAction("open_project", ctx);
    expect(store.invalidateMemory).not.toHaveBeenCalled();
  });

  it("works fine when invalidateMemory is omitted (optional field, other callers untouched)", async () => {
    const { ctx } = makeCtx({}, {});
    delete (ctx.store as { invalidateMemory?: unknown }).invalidateMemory;
    await expect(runAction("new_project", ctx)).resolves.toBeUndefined();
  });

  // AGT-MEM (M3, item 5) — session summaries: a terse recap of this session's
  // meaningful commands, written as a PROJECT note for the OUTGOING project right
  // before it's replaced. sessionLog.ts is a real module-level singleton (mirrors
  // hydrate.ts's cache) — these tests seed/reset it directly rather than mocking it,
  // same posture as brainMemory.test.ts driving the real hydrate.ts against a fake
  // bridge.
  describe("session summary on project switch", () => {
    const snapWithFile = (editFile: string): Snapshot => ({
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile },
      tracks: [],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    });

    beforeEach(() => __resetSessionLogForTests());

    it("writes a project-scope summary note BEFORE the real switch, then clears the log", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const { ctx, store, execCalls } = makeCtx({}, { snapshot: snapWithFile("/Users/e/song.mosh") });

      await runAction("new_project", ctx);

      const writeCall = execCalls.find((c) => c.command === "agent_memory_write");
      expect(writeCall).toBeDefined();
      expect(writeCall!.args).toMatchObject({ scope: "project", kind: "summary" });
      expect((writeCall!.args as { item: string }).item).toContain("Added track \"Hats\"");
      // the summary write happens BEFORE the actual project swap
      const writeIdx = execCalls.findIndex((c) => c.command === "agent_memory_write");
      const switchIdx = execCalls.findIndex((c) => c.command === "new_project");
      expect(writeIdx).toBeLessThan(switchIdx);
      expect(getSessionLog()).toEqual([]); // cleared for the incoming project
      void store;
    });

    it("skips the write entirely when there is no edit file yet (unsaved session)", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const { ctx, execCalls } = makeCtx({}, { snapshot: snapWithFile("") });

      await runAction("new_project", ctx);

      expect(execCalls.some((c) => c.command === "agent_memory_write")).toBe(false);
      expect(getSessionLog()).toEqual([]); // still cleared — an unsaved session's log shouldn't leak either
    });

    it("skips the write when nothing meaningful happened this session (empty digest)", async () => {
      recordSessionCommand("get_snapshot", {}, true); // noisy-only
      const { ctx, execCalls } = makeCtx({}, { snapshot: snapWithFile("/Users/e/song.mosh") });

      await runAction("new_project", ctx);

      expect(execCalls.some((c) => c.command === "agent_memory_write")).toBe(false);
    });

    it("uses the raw digest verbatim when ctx.chat is omitted", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const { ctx, execCalls } = makeCtx({}, { snapshot: snapWithFile("/Users/e/song.mosh") });
      delete (ctx as { chat?: unknown }).chat;

      await runAction("new_project", ctx);

      const writeCall = execCalls.find((c) => c.command === "agent_memory_write");
      expect((writeCall!.args as { item: string }).item).toBe("- Added track \"Hats\"");
    });

    it("uses the chat-polished text when ctx.chat is provided and succeeds", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const chat = vi.fn(async () => ({ content: "Built out a Hats track." }));
      const { ctx, execCalls } = makeCtx({ chat }, { snapshot: snapWithFile("/Users/e/song.mosh") });

      await runAction("new_project", ctx);

      expect(chat).toHaveBeenCalledOnce();
      const writeCall = execCalls.find((c) => c.command === "agent_memory_write");
      expect((writeCall!.args as { item: string }).item).toBe("Built out a Hats track.");
    });

    it("falls back to the raw digest when the chat polish throws — the switch still proceeds", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const chat = vi.fn(async () => { throw new Error("brain unavailable"); });
      const { ctx, store, execCalls } = makeCtx({ chat }, { snapshot: snapWithFile("/Users/e/song.mosh") });

      await runAction("new_project", ctx);

      const writeCall = execCalls.find((c) => c.command === "agent_memory_write");
      expect((writeCall!.args as { item: string }).item).toBe("- Added track \"Hats\"");
      expect(execCalls.some((c) => c.command === "new_project")).toBe(true);
      expect(store.refresh).toHaveBeenCalled();
    });

    it("a failed agent_memory_write does not block the real project switch", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const calls: { command: string; args?: Record<string, unknown> }[] = [];
      const { ctx, store } = makeCtx(
        {},
        {
          snapshot: snapWithFile("/Users/e/song.mosh"),
          exec: vi.fn(async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args });
            if (command === "agent_memory_write") return { ok: false, error: "disk full" };
            return { ok: true };
          }),
        },
      );

      await expect(runAction("new_project", ctx)).resolves.toBeUndefined();
      expect(calls.some((c) => c.command === "new_project")).toBe(true);
      expect(store.refresh).toHaveBeenCalled();
      expect(getSessionLog()).toEqual([]); // still cleared even though the write failed
    });

    it("a cancelled open_project picker skips the summary write AND leaves the session log untouched", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const { ctx, execCalls } = makeCtx(
        { pickFiles: vi.fn(async () => ({ ok: false, files: [] })) },
        { snapshot: snapWithFile("/Users/e/song.mosh") },
      );

      await runAction("open_project", ctx);

      expect(execCalls.some((c) => c.command === "agent_memory_write")).toBe(false);
      expect(getSessionLog()).toHaveLength(1); // NOT cleared — no switch happened
    });

    it("open_recent also writes the summary before the real switch", async () => {
      recordSessionCommand("create_track", { name: "Hats" }, true);
      const { ctx, execCalls } = makeCtx({}, { snapshot: snapWithFile("/Users/e/song.mosh") });

      await runAction("open_recent", ctx, { index: 0 });

      expect(execCalls.some((c) => c.command === "agent_memory_write")).toBe(true);
      expect(execCalls.some((c) => c.command === "open_recent")).toBe(true);
    });
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

  it("record uses the store recording lifecycle when available", async () => {
    const enterRecord = vi.fn(async () => {});
    const { ctx, execCalls } = makeCtx({}, { enterRecord });

    await runAction("record", ctx);

    expect(enterRecord).toHaveBeenCalledOnce();
    expect(execCalls).toEqual([]);
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

// FU-CLIP-NUDGE — fine clip nudge: fixed-increment move_clip, independent of
// drag/snap. The increment is one step of the current snap division (default
// "1/4"), evaluated at each clip's own position over the session's tempo map —
// at the default 120bpm 4/4 session a "1/4" step is 0.5s.
describe("runAction — clip nudge (FU-CLIP-NUDGE)", () => {
  function snapshotWithClips(clips: { id: string; start: number; length?: number }[]) {
    return {
      session: {},
      tracks: [
        { id: "t1", isGroup: false, clips: clips.map((c) => ({ id: c.id, start: c.start, length: c.length ?? 2 })) },
      ],
    } as unknown as import("./types").Snapshot;
  }

  it("nudge_right moves every selected clip forward by one grid-division step", async () => {
    const snapshot = snapshotWithClips([{ id: "c1", start: 2 }, { id: "c2", start: 5 }]);
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(["c1", "c2"]), snapshot });
    await runAction("nudge_right", ctx);
    expect(execCalls).toEqual([
      { command: "move_clip", args: { clipId: "c1", start: 2.5 } },
      { command: "move_clip", args: { clipId: "c2", start: 5.5 } },
    ]);
  });

  it("nudge_left moves every selected clip backward by one grid-division step", async () => {
    const snapshot = snapshotWithClips([{ id: "c1", start: 2 }]);
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(["c1"]), snapshot });
    await runAction("nudge_left", ctx);
    expect(execCalls).toEqual([{ command: "move_clip", args: { clipId: "c1", start: 1.5 } }]);
  });

  it("clamps the new start at 0 instead of going negative", async () => {
    const snapshot = snapshotWithClips([{ id: "c1", start: 0.2 }]);
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(["c1"]), snapshot });
    await runAction("nudge_left", ctx);
    expect(execCalls).toEqual([{ command: "move_clip", args: { clipId: "c1", start: 0 } }]);
  });

  it("is a no-op with nothing selected", async () => {
    const snapshot = snapshotWithClips([{ id: "c1", start: 2 }]);
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(), snapshot });
    await runAction("nudge_left", ctx);
    await runAction("nudge_right", ctx);
    expect(execCalls).toEqual([]);
  });

  it("steps by the CURRENT snap division, not a hardcoded amount", async () => {
    const snapshot = snapshotWithClips([{ id: "c1", start: 2 }]);
    const { ctx, execCalls } = makeCtx({}, { selection: new Set(["c1"]), snapshot, snapDivision: "1/8" });
    await runAction("nudge_right", ctx);
    expect(execCalls).toEqual([{ command: "move_clip", args: { clipId: "c1", start: 2.25 } }]);
  });
});
