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

  it("reconciles command-confirmed transport state before telemetry", async () => {
    const reconcileTransport = vi.fn();
    const { ctx } = makeCtx({}, {
      reconcileTransport,
      exec: vi.fn(async () => ({
        ok: true,
        command: "set_transport",
        data: { playing: false, recording: false, position: 4.5, ignored: "field" },
      })),
    });

    await runAction("play_pause", ctx);

    expect(reconcileTransport).toHaveBeenCalledOnce();
    expect(reconcileTransport).toHaveBeenCalledWith({
      playing: false,
      recording: false,
      position: 4.5,
    });
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

  it("record finalizes through transport when recording is already active", async () => {
    const enterRecord = vi.fn(async () => {});
    const { ctx, execCalls } = makeCtx({}, {
      enterRecord,
      transport: { playing: true, recording: true, position: 3 },
    });

    await runAction("record", ctx);

    expect(enterRecord).not.toHaveBeenCalled();
    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
    ]);
  });

  it("uses live recording intent when transport telemetry is stale", async () => {
    const enterRecord = vi.fn(async () => {});
    const { ctx, execCalls } = makeCtx({}, {
      enterRecord,
      currentMode: () => "recording",
      transport: { playing: false, recording: false, position: 3 },
    });

    await runAction("record", ctx);

    expect(enterRecord).not.toHaveBeenCalled();
    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
    ]);
  });

  it("serializes rapid menu Record actions before choosing start or finalize", async () => {
    let releaseStart: (() => void) | undefined;
    let mode: "idle" | "recording" = "idle";
    const enterRecord = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseStart = resolve; });
      mode = "recording";
    });
    const { ctx, execCalls } = makeCtx({}, {
      enterRecord,
      currentMode: () => mode,
      transport: { playing: false, recording: false, position: 3 },
    });

    const first = runAction("record", ctx);
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf("function"));
    const second = runAction("record", ctx);
    expect(enterRecord).toHaveBeenCalledOnce();
    releaseStart!();
    await Promise.all([first, second]);

    expect(enterRecord).toHaveBeenCalledOnce();
    expect(execCalls).toEqual([
      { command: "set_transport", args: { action: "record" } },
    ]);
  });

  it("does not run transport or recording actions during a project transition", async () => {
    const enterRecord = vi.fn(async () => {});
    const { ctx, execCalls } = makeCtx({}, {
      enterRecord,
      projectTransitioning: true,
    });

    await runAction("record", ctx);
    await runAction("play_pause", ctx);
    await runAction("to_start", ctx);

    expect(enterRecord).not.toHaveBeenCalled();
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

// PRJ-NAME — the native file-picker filters for project I/O.
//
// Open must accept BOTH the current extension and the legacy .tracktionedit: projects
// saved before the rename are never migrated, so filtering them out would make a
// producer's existing work look like it had vanished. Save As must offer only the
// current one — it should never propose the legacy format as a NEW destination.
describe("project picker filters (PRJ-NAME)", () => {
  const snapWith = (over: Record<string, unknown>): Snapshot => ({
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, key: { tonic: "C", mode: "major" }, length: 16,
      editFile: "/Users/e/untitled - bearcat.mosh", ...over,
    },
    tracks: [],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as Snapshot);

  it("open_project filters on the backend-reported extension AND the legacy one", async () => {
    const { ctx } = makeCtx({}, { snapshot: snapWith({ projectExtension: "mosh" }) });
    await runAction("open_project", ctx);
    const filters = (ctx.pickFiles as ReturnType<typeof vi.fn>).mock.calls[0][0].filters as string;
    expect(filters).toContain("*.mosh");
    expect(filters).toContain("*.tracktionedit");
  });

  it("falls back to *.mosh when the snapshot omits projectExtension", async () => {
    const { ctx } = makeCtx({}, { snapshot: snapWith({}) });
    await runAction("open_project", ctx);
    const filters = (ctx.pickFiles as ReturnType<typeof vi.fn>).mock.calls[0][0].filters as string;
    expect(filters).toContain("*.mosh");
    expect(filters).toContain("*.tracktionedit");
  });

  it("follows the backend when it reports a DIFFERENT extension (no second source of truth)", async () => {
    const { ctx } = makeCtx({}, { snapshot: snapWith({ projectExtension: "msh" }) });
    await runAction("open_project", ctx);
    const filters = (ctx.pickFiles as ReturnType<typeof vi.fn>).mock.calls[0][0].filters as string;
    expect(filters).toContain("*.msh");
    expect(filters).not.toContain("*.mosh");
  });

  it("save_as filters on the current extension only, and pre-fills the project stem", async () => {
    const { ctx } = makeCtx({}, { snapshot: snapWith({ projectExtension: "mosh" }) });
    await runAction("save_as", ctx);
    const opts = (ctx.pickSaveFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.filters).toBe("*.mosh");
    expect(opts.filters).not.toContain("tracktionedit");
    expect(opts.defaultName).toBe("untitled - bearcat.mosh");
  });

  it("save_as of a LEGACY project pre-fills its stem with the current extension", async () => {
    const { ctx } = makeCtx({}, {
      snapshot: snapWith({ editFile: "/Users/e/old song.tracktionedit", projectExtension: "tracktionedit" }),
    });
    await runAction("save_as", ctx);
    const opts = (ctx.pickSaveFile as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.defaultName).toBe("old song.tracktionedit");
  });
});

// Live-12 arrangement keys (SPEC §8, docs/live-clone/PARITY.md) — the ableton
// keymap's bindings land here through the shared dispatcher.
describe("runAction — Live-12 arrangement keys", () => {
  const snapFor = (tracks: unknown[]): Snapshot => ({
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "",
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot);

  it("loop_toggle arms a collapsed loop as the first four bars (4/4 at 120bpm → 8s)", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      transport: { playing: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      snapshot: snapFor([]),
    });
    await runAction("loop_toggle", ctx);
    expect(execCalls).toContainEqual({ command: "set_transport", args: { loop: true, loopStart: 0, loopEnd: 8 } });
  });

  it("loop_toggle re-arms the existing range, and releases an armed loop", async () => {
    const on = makeCtx({}, { transport: { playing: false, looping: false, loopStart: 2, loopEnd: 6 } });
    await runAction("loop_toggle", on.ctx);
    expect(on.execCalls).toContainEqual({ command: "set_transport", args: { loop: true, loopStart: 2, loopEnd: 6 } });
    const off = makeCtx({}, { transport: { playing: false, looping: true, loopStart: 2, loopEnd: 6 } });
    await runAction("loop_toggle", off.ctx);
    expect(off.execCalls).toContainEqual({ command: "set_transport", args: { loop: false } });
  });

  it("loop_toggle loops the drawn time selection when one exists (⌘L over a span)", async () => {
    const { useShell } = await import("./v2/shellState");
    useShell.getState().setTimeRange({ start: 2, end: 6 });
    try {
      const { ctx, execCalls } = makeCtx();
      await runAction("loop_toggle", ctx);
      expect(execCalls).toContainEqual({ command: "set_transport", args: { loop: true, loopStart: 2, loopEnd: 6 } });
    } finally {
      useShell.getState().setTimeRange(null);
    }
  });

  it("deactivate mutes a mixed selection wholesale, and re-activates an all-muted one", async () => {
    const tracks = [{ id: "t1", clips: [
      { id: "c1", mute: false }, { id: "c2", mute: true },
    ] }];
    const mixed = makeCtx({}, { snapshot: snapFor(tracks), selection: new Set(["c1", "c2"]) });
    await runAction("deactivate", mixed.ctx);
    // any active ⇒ deactivate ALL (the note editor's toggleActiveEdits semantics)
    expect(mixed.execCalls).toEqual([
      { command: "set_clip_mute", args: { clipId: "c1", mute: true } },
      { command: "set_clip_mute", args: { clipId: "c2", mute: true } },
    ]);
    const allMuted = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [{ id: "c1", mute: true }] }]),
      selection: new Set(["c1"]),
    });
    await runAction("deactivate", allMuted.ctx);
    expect(allMuted.execCalls).toEqual([{ command: "set_clip_mute", args: { clipId: "c1", mute: false } }]);
  });

  it("deactivate with an empty selection is a no-op", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("deactivate", ctx);
    expect(execCalls).toEqual([]);
  });

  it("grid_narrow / grid_widen step the division and clamp at both ends", async () => {
    const narrow = makeCtx({}, { snapDivision: "1/4", setSnapDivision: vi.fn() });
    await runAction("grid_narrow", narrow.ctx);
    expect(narrow.store.setSnapDivision).toHaveBeenCalledWith("1/8");
    const widen = makeCtx({}, { snapDivision: "1/4", setSnapDivision: vi.fn() });
    await runAction("grid_widen", widen.ctx);
    expect(widen.store.setSnapDivision).toHaveBeenCalledWith("bar");
    // already-coarsest: stays put (no pointless write)
    const clamped = makeCtx({}, { snapDivision: "bar", setSnapDivision: vi.fn() });
    await runAction("grid_widen", clamped.ctx);
    expect(clamped.store.setSnapDivision).not.toHaveBeenCalled();
  });

  it("snap_toggle flips the store snap flag", async () => {
    const on = makeCtx({}, { snap: true, setSnap: vi.fn() });
    await runAction("snap_toggle", on.ctx);
    expect(on.store.setSnap).toHaveBeenCalledWith(false);
    const off = makeCtx({}, { snap: false, setSnap: vi.fn() });
    await runAction("snap_toggle", off.ctx);
    expect(off.store.setSnap).toHaveBeenCalledWith(true);
  });

  it("zoom_in / zoom_out scale pxPerSec by 1.25 (the store setter owns the clamp)", async () => {
    const zin = makeCtx({}, { pxPerSec: 80, setPxPerSec: vi.fn() });
    await runAction("zoom_in", zin.ctx);
    expect(zin.store.setPxPerSec).toHaveBeenCalledWith(100);
    const zout = makeCtx({}, { pxPerSec: 80, setPxPerSec: vi.fn() });
    await runAction("zoom_out", zout.ctx);
    expect(zout.store.setPxPerSec).toHaveBeenCalledWith(64);
  });
});

// Wave 0 (menus.json ground truth) — creation / quantize / selection actions.
describe("runAction — wave-0 Live menu actions", () => {
  const snapFor = (tracks: unknown[]): Snapshot => ({
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "",
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot);

  it("insert_audio_track → create_track; insert_midi_track → create_track + add_midi_clip on the new track", async () => {
    // Read the exec mock's own call log here (not execCalls): the create_track result
    // has to carry a trackId, so the fake's implementation is swapped for one that
    // returns it — and execCalls only records through the ORIGINAL implementation.
    const callsOf = (store: ActionStore) =>
      (store.exec as ReturnType<typeof vi.fn>).mock.calls.map(([command, args]) => ({ command, args }));
    const audio = makeCtx();
    (audio.store.exec as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) =>
      ({ ok: true, command, data: command === "create_track" ? { trackId: "t9" } : undefined }));
    await runAction("insert_audio_track", audio.ctx);
    expect(callsOf(audio.store)).toEqual([{ command: "create_track", args: { name: "Audio" } }]);

    const midi = makeCtx();
    (midi.store.exec as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) =>
      ({ ok: true, command, data: command === "create_track" ? { trackId: "t9" } : undefined }));
    await runAction("insert_midi_track", midi.ctx);
    expect(callsOf(midi.store)).toEqual([
      { command: "create_track", args: { name: "Instrument" } },
      // the explicit trackId keeps mock and native identical (TrackLaneList's comment)
      { command: "add_midi_clip", args: { trackId: "t9" } },
    ]);
  });

  it("insert_midi_clip lands on the selected track over the drawn time span", async () => {
    const { useShell } = await import("./v2/shellState");
    useShell.getState().setTimeRange({ start: 2, end: 6 });
    try {
      const { ctx, execCalls } = makeCtx({}, {
        snapshot: snapFor([{ id: "t1", clips: [] }, { id: "t2", clips: [] }]),
        selectedTrackId: "t2",
      });
      await runAction("insert_midi_clip", ctx);
      expect(execCalls).toContainEqual({ command: "add_midi_clip", args: { trackId: "t2", start: 2, length: 4 } });
    } finally {
      useShell.getState().setTimeRange(null);
    }
  });

  it("insert_midi_clip without a span plants one bar at the playhead on the first track", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [] }]),
      transport: { playing: false, position: 3 },
    });
    await runAction("insert_midi_clip", ctx);
    // 4/4 at 120bpm → a 2s bar
    expect(execCalls).toContainEqual({ command: "add_midi_clip", args: { trackId: "t1", start: 3, length: 2 } });
  });

  it("quantize hits only selected clips that HAVE notes, on the current grid division", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [
        { id: "c1", type: "midi", start: 0, notes: [{ i: 0, pitch: 60, start: 0.13, length: 0.5, velocity: 100 }] },
        { id: "c2", type: "midi", start: 0, notes: [] },
        { id: "c3", type: "wave", start: 0 },
      ] }]),
      selection: new Set(["c1", "c2", "c3"]),
      snapDivision: "1/8",
    });
    await runAction("quantize", ctx);
    // 1/8 at 120bpm = 0.5 beats; the empty MIDI clip and the wave clip are skipped
    expect(execCalls).toEqual([{ command: "quantize_notes", args: { clipId: "c1", division: 0.5 } }]);
  });

  it("select_loop draws the armed loop as a time selection; inert with no loop", async () => {
    const { useShell } = await import("./v2/shellState");
    const on = makeCtx({}, { transport: { playing: false, looping: true, loopStart: 4, loopEnd: 8 } });
    await runAction("select_loop", on.ctx);
    expect(useShell.getState().timeRange).toEqual({ start: 4, end: 8 });
    useShell.getState().setTimeRange(null);
    const off = makeCtx({}, { transport: { playing: false, looping: false, loopStart: 0, loopEnd: 0 } });
    await runAction("select_loop", off.ctx);
    expect(useShell.getState().timeRange).toBeNull();
  });

  it("select_all selects every clip; invert selects the complement (and can empty it)", async () => {
    const tracks = [{ id: "t1", clips: [{ id: "c1" }, { id: "c2" }] }, { id: "t2", clips: [{ id: "c3" }] }];
    const all = makeCtx({}, { snapshot: snapFor(tracks), select: vi.fn() });
    await runAction("select_all", all.ctx);
    expect(all.store.select).toHaveBeenCalledWith(["c1", "c2", "c3"]);
    const inv = makeCtx({}, { snapshot: snapFor(tracks), selection: new Set(["c2"]), select: vi.fn() });
    await runAction("invert_selection", inv.ctx);
    expect(inv.store.select).toHaveBeenCalledWith(["c1", "c3"]);
  });
});

describe("runAction — wave-2 (consolidate / grid_triplet)", () => {
  const snapFor = (tracks: unknown[]): Snapshot => ({
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "",
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot);

  it("consolidate passes exactly the selected clips' ids to consolidate_clips", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [
        { id: "c1", type: "midi" }, { id: "c2", type: "midi" }, { id: "c3", type: "wave" },
      ] }]),
      selection: new Set(["c1", "c2"]),
    });
    await runAction("consolidate", ctx);
    expect(execCalls).toContainEqual({ command: "consolidate_clips", args: { clipIds: ["c1", "c2"] } });
  });

  it("consolidate surfaces an engine refusal (e.g. audio in the selection) via setLastError", async () => {
    const setLastError = vi.fn();
    const { ctx } = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [{ id: "c3", type: "wave" }] }]),
      selection: new Set(["c3"]),
      setLastError,
      exec: vi.fn(async (command: string) => ({ ok: false, command, error: "MIDI clips only — consolidating audio needs a render (not built)" })),
    });
    await runAction("consolidate", ctx);
    expect(setLastError).toHaveBeenCalledWith(expect.stringContaining("MIDI clips only"));
  });

  it("consolidate with an empty selection sends nothing", async () => {
    const { ctx, execCalls } = makeCtx();
    await runAction("consolidate", ctx);
    expect(execCalls).toEqual([]);
  });

  it("grid_triplet flips the store's snapTriplet flag", async () => {
    const on = makeCtx({}, { snapTriplet: false, setSnapTriplet: vi.fn() });
    await runAction("grid_triplet", on.ctx);
    expect(on.store.setSnapTriplet).toHaveBeenCalledWith(true);
  });
});

describe("runAction — crop_clip (⇧⌘J)", () => {
  const snapFor = (tracks: unknown[]): Snapshot => ({
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "",
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot);

  it("passes the selected clips + the drawn time selection to crop_clip", async () => {
    const { useShell } = await import("./v2/shellState");
    useShell.getState().setTimeRange({ start: 2, end: 6 });
    try {
      const { ctx, execCalls } = makeCtx({}, {
        snapshot: snapFor([{ id: "t1", clips: [{ id: "c1" }, { id: "c2" }] }]),
        selection: new Set(["c1"]),
      });
      await runAction("crop_clip", ctx);
      expect(execCalls).toContainEqual({ command: "crop_clip", args: { clipIds: ["c1"], start: 2, end: 6 } });
    } finally {
      useShell.getState().setTimeRange(null);
    }
  });

  it("with NO time selection it errors honestly and sends nothing (no playhead fallback)", async () => {
    const setLastError = vi.fn();
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [{ id: "c1" }] }]),
      selection: new Set(["c1"]),
      setLastError,
    });
    await runAction("crop_clip", ctx);
    expect(execCalls).toEqual([]);
    expect(setLastError).toHaveBeenCalledWith(expect.stringContaining("time selection"));
  });

  it("with an empty clip selection it errors and sends nothing", async () => {
    const setLastError = vi.fn();
    const { useShell } = await import("./v2/shellState");
    useShell.getState().setTimeRange({ start: 2, end: 6 });
    try {
      const { ctx, execCalls } = makeCtx({}, { setLastError });
      await runAction("crop_clip", ctx);
      expect(execCalls).toEqual([]);
      expect(setLastError).toHaveBeenCalledWith(expect.stringContaining("no clips selected"));
    } finally {
      useShell.getState().setTimeRange(null);
    }
  });

  it("surfaces an engine refusal (e.g. no overlap) via setLastError", async () => {
    const { useShell } = await import("./v2/shellState");
    useShell.getState().setTimeRange({ start: 2, end: 6 });
    try {
      const setLastError = vi.fn();
      const { ctx } = makeCtx({}, {
        snapshot: snapFor([{ id: "t1", clips: [{ id: "c1" }] }]),
        selection: new Set(["c1"]),
        setLastError,
        exec: vi.fn(async (command: string) => ({ ok: false, command, error: "the time selection does not overlap the clip(s)" })),
      });
      await runAction("crop_clip", ctx);
      expect(setLastError).toHaveBeenCalledWith(expect.stringContaining("does not overlap"));
    } finally {
      useShell.getState().setTimeRange(null);
    }
  });
});

describe("runAction — keymap-audit wave (nudge_up/down, ungroup, insert_silence, create_fade, group-by-track)", () => {
  const snapFor = (tracks: unknown[]): Snapshot => ({
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "",
    },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  } as unknown as Snapshot);

  it("nudge_down moves selected clips to the track below; the bottom track's clips stay", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([
        { id: "t1", clips: [{ id: "c1" }] },
        { id: "t2", clips: [{ id: "c2" }] },
        { id: "t3", clips: [{ id: "c3" }] },
      ]),
      selection: new Set(["c1", "c3"]),
    });
    await runAction("nudge_down", ctx);
    // c1 → t2; c3 is already on the bottom track and stays (drop, not error)
    expect(execCalls).toEqual([{ command: "move_clip", args: { clipId: "c1", trackId: "t2" } }]);
  });

  it("nudge_up moves to the track above; the top track's clips stay", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([
        { id: "t1", clips: [{ id: "c1" }] },
        { id: "t2", clips: [{ id: "c2" }] },
      ]),
      selection: new Set(["c1", "c2"]),
    });
    await runAction("nudge_up", ctx);
    expect(execCalls).toEqual([{ command: "move_clip", args: { clipId: "c2", trackId: "t1" } }]);
  });

  it("ungroup unwraps the selected track's PARENT group", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([
        { id: "g1", isGroup: true, type: "group", clips: [] },
        { id: "t1", parentId: "g1", clips: [] },
      ]),
      selectedTrackId: "t1",
    });
    await runAction("ungroup", ctx);
    expect(execCalls).toContainEqual({ command: "ungroup_track", args: { trackId: "g1" } });
  });

  it("ungroup on a selected group track unwraps it directly", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([{ id: "g1", isGroup: true, type: "group", clips: [] }]),
      selectedTrackId: "g1",
    });
    await runAction("ungroup", ctx);
    expect(execCalls).toContainEqual({ command: "ungroup_track", args: { trackId: "g1" } });
  });

  it("insert_silence uses the time selection when one exists, else one bar at the playhead", async () => {
    const { useShell } = await import("./v2/shellState");
    useShell.getState().setTimeRange({ start: 2, end: 6 });
    try {
      const { ctx, execCalls } = makeCtx({}, { snapshot: snapFor([]) });
      await runAction("insert_silence", ctx);
      expect(execCalls).toContainEqual({ command: "insert_time", args: { start: 2, duration: 4 } });
    } finally {
      useShell.getState().setTimeRange(null);
    }
    const { ctx: ctx2, execCalls: calls2 } = makeCtx({}, {
      snapshot: snapFor([]),
      transport: { playing: false, position: 3 },
    });
    await runAction("insert_silence", ctx2);
    // 4/4 at 120bpm → a 2s bar at the playhead
    expect(calls2).toContainEqual({ command: "insert_time", args: { start: 3, duration: 2 } });
  });

  it("create_fade applies Live's 4ms default to selected WAVE clips only", async () => {
    const { ctx, execCalls } = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [
        { id: "w1", type: "wave" }, { id: "m1", type: "midi" },
      ] }]),
      selection: new Set(["w1", "m1"]),
    });
    await runAction("create_fade", ctx);
    expect(execCalls).toEqual([{ command: "set_clip_fade", args: { clipId: "w1", fadeInSec: 0.004, fadeOutSec: 0.004 } }]);
  });

  it("group falls back to the track selection when no clips are selected", async () => {
    const byClips = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [{ id: "c1" }] }]),
      selection: new Set(["c1"]),
    });
    await runAction("group", byClips.ctx);
    expect(byClips.execCalls).toContainEqual({ command: "create_group_track", args: { trackIds: ["t1"] } });

    const byTrack = makeCtx({}, {
      snapshot: snapFor([{ id: "t1", clips: [] }]),
      selection: new Set<string>(),
      selectedTrackId: "t1",
    });
    await runAction("group", byTrack.ctx);
    expect(byTrack.execCalls).toContainEqual({ command: "create_group_track", args: { trackIds: ["t1"] } });

    const nothing = makeCtx({}, { snapshot: snapFor([{ id: "t1", clips: [] }]), selection: new Set<string>() });
    await runAction("group", nothing.ctx);
    expect(nothing.execCalls).toEqual([]);
  });
});
