// The loop FSM, unit-tested with a scripted chat + a scripted env — the
// skillHarness deps-injection idiom. No network, no store: the FSM's contract
// is (chat replies in, batches out, outcome honest).

import { describe, it, expect } from "vitest";
import { runAgentLoop, DEFAULT_LOOP_BUDGETS, type LoopDeps } from "./loop";
import type { Snapshot } from "../../types";
import type { StepCommandResult } from "../loopSeam";

const SNAP = { schemaVersion: 1, session: { tempo: 120 }, tracks: [], transport: {}, master: { volumeDb: -3, pan: 0, plugins: [] } } as unknown as Snapshot;

function scriptedChat(replies: Array<Record<string, unknown> | string>) {
  const seen: string[] = [];
  return {
    seen,
    chat: async (messages: Array<{ role: string; content: string }>) => {
      seen.push(messages[messages.length - 1]!.content);
      const next = replies.shift();
      if (next === undefined) throw new Error("scripted chat exhausted");
      return { content: typeof next === "string" ? next : JSON.stringify(next), ms: 1 };
    },
  };
}

/** Env whose runBatch pops scripted per-batch results; ok-by-default. */
function scriptedEnv(script: Array<StepCommandResult[] | "ok">) {
  const batches: Array<{ label: string; commands: string[] }> = [];
  return {
    batches,
    env: {
      async getSnapshot() { return SNAP; },
      async runBatch(label: string, calls: readonly { command: string }[]) {
        batches.push({ label, commands: calls.map((c) => c.command) });
        const next = script.shift() ?? "ok";
        const results = next === "ok"
          ? calls.map((c) => ({ command: c.command, ok: true }))
          : next;
        return { results, snapshot: SNAP };
      },
    },
  };
}

const CMD = (command: string, args: Record<string, unknown> = {}) => ({ command, args });

describe("runAgentLoop — the FSM", () => {
  it("happy path: a fully-inline plan executes with ONE model call and finishes done", async () => {
    const { chat, seen } = scriptedChat([
      { intent: "ACK_WORKING", say: "building it", status: "continue", plan: [
        { goal: "tempo", commands: [CMD("set_tempo", { bpm: 90 })] },
        { goal: "drums", commands: [CMD("add_drum_pattern", { pattern: "kick: x..." })] },
      ] },
    ]);
    const { env, batches } = scriptedEnv(["ok", "ok"]);
    const run = await runAgentLoop({ ask: "make a beat" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("done");
    expect(run.stepCount).toBe(2);
    expect(batches.map((b) => b.commands)).toEqual([["set_tempo"], ["add_drum_pattern"]]);
    expect(seen).toHaveLength(1); // plan call only — no closing call for a completed plan
    expect(run.deferred).toBe(false);
  });

  it("goal-only plan steps are compiled with one call each, then done at exhaustion", async () => {
    const { chat, seen } = scriptedChat([
      { status: "continue", plan: [{ goal: "set the tempo" }, { goal: "mute the vocal" }] },
      { status: "continue", commands: [CMD("set_tempo", { bpm: 100 })] },
      { status: "continue", commands: [CMD("set_track_mute", { trackId: "1", mute: true })] },
    ]);
    const { env, batches } = scriptedEnv(["ok", "ok"]);
    const run = await runAgentLoop({ ask: "prep the session" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("done");
    expect(batches).toHaveLength(2);
    expect(seen).toHaveLength(3);
    expect(seen[1]).toContain("set the tempo");   // the compile call names its goal
    expect(seen[2]).toContain("mute the vocal");
  });

  it("a compile reply that re-wraps its commands inside a plan entry is still executed (first live produce run, 2026-09-02)", async () => {
    const { chat } = scriptedChat([
      { status: "continue", plan: [{ goal: "drums" }, { goal: "808" }] },
      // compile for "drums": commands at top level (the documented shape)
      { status: "continue", commands: [CMD("add_midi_clip", { trackId: "1", start: 0, length: 32 })] },
      // compile for "808": Sonnet echoed the plan and put the commands in plan[1]
      { status: "continue", plan: [{ goal: "drums" }, { goal: "808", commands: [CMD("add_midi_clip", { trackId: "2", start: 0, length: 32 })] }] },
    ]);
    const { env, batches } = scriptedEnv(["ok", "ok"]);
    const run = await runAgentLoop({ ask: "produce a beat" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("done");
    expect(batches).toHaveLength(2);
    expect(batches[1]!.commands).toEqual(["add_midi_clip"]);
  });

  it("a compile reply whose plan carries commands in SEVERAL entries is still 'no commands' (error, not a guess)", async () => {
    const { chat } = scriptedChat([
      { status: "continue", plan: [{ goal: "drums" }] },
      { status: "continue", plan: [{ goal: "a", commands: [CMD("set_tempo", { bpm: 90 })] }, { goal: "b", commands: [CMD("set_tempo", { bpm: 91 })] }] },
    ]);
    const { env, batches } = scriptedEnv([]);
    const run = await runAgentLoop({ ask: "produce a beat" }, { chat, env } as LoopDeps);
    expect(run.outcome).toBe("error");
    expect(batches).toHaveLength(0);
  });

  it("a failed step triggers ONE repair call that sees the verbatim error", async () => {
    const { chat, seen } = scriptedChat([
      { status: "continue", plan: [{ goal: "warp", commands: [CMD("set_clip_warp", { clipId: "9", autoTempo: true })] }] },
      { status: "done", say: "fixed", commands: [CMD("stretch_clip", { clipId: "9", bars: 4 })] },
    ]);
    const { env, batches } = scriptedEnv([
      [{ command: "set_clip_warp", ok: false, error: "not an audio clip" }],
      "ok",
    ]);
    const run = await runAgentLoop({ ask: "warp it" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("done");
    expect(run.stepCount).toBe(2);
    expect(seen[1]).toContain("not an audio clip");      // the error envelope, verbatim
    expect(batches[1]!.commands).toEqual(["stretch_clip"]);
  });

  it("a repair that keeps failing lands outcome error within the planner budget", async () => {
    const fail = [{ command: "set_tempo", ok: false, error: "nope" }];
    const { chat } = scriptedChat([
      { status: "continue", plan: [{ goal: "t", commands: [CMD("set_tempo", { bpm: 90 })] }] },
      { status: "continue", commands: [CMD("set_tempo", { bpm: 90 })] },  // repair 1 — fails again
      { status: "continue", commands: [CMD("set_tempo", { bpm: 90 })] },  // repair 2 — fails again
    ]);
    const { env } = scriptedEnv([fail, fail, fail]);
    const run = await runAgentLoop({ ask: "x" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("error");
    expect(run.stepCount).toBe(3); // original + 2 repair attempts, then the planner budget (3) is spent
  });

  it("need_user parks the task deferred with zero batches", async () => {
    const { chat } = scriptedChat([{ intent: "HUH", say: "which clip?", status: "need_user" }]);
    const { env, batches } = scriptedEnv([]);
    const run = await runAgentLoop({ ask: "fix the bad one" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("need_user");
    expect(run.deferred).toBe(true);
    expect(run.say).toBe("which clip?");
    expect(batches).toHaveLength(0);
  });

  it("bare-commands incremental mode: continue → another call, done closes", async () => {
    const { chat, seen } = scriptedChat([
      { status: "continue", commands: [CMD("create_track", { name: "A" })] },
      { status: "done", commands: [CMD("set_track_volume", { trackId: "1", db: -3 })] },
    ]);
    const { env, batches } = scriptedEnv(["ok", "ok"]);
    const run = await runAgentLoop({ ask: "add and level a track" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("done");
    expect(batches).toHaveLength(2);
    expect(seen).toHaveLength(2);
  });

  it("the step budget stops a runaway plan honestly", async () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({ goal: `s${i}`, commands: [CMD("set_tempo", { bpm: 60 + i })] }));
    const { chat } = scriptedChat([{ status: "continue", plan: steps }]);
    const { env, batches } = scriptedEnv(Array(10).fill("ok"));
    const run = await runAgentLoop({ ask: "x" }, { chat, env, budgets: { maxSteps: 3 } } as LoopDeps);

    expect(run.outcome).toBe("budget");
    expect(batches).toHaveLength(3);
  });

  it("abort stops before the next step and reports aborted", async () => {
    const signal = { aborted: false };
    const { chat } = scriptedChat([
      { status: "continue", plan: [
        { goal: "a", commands: [CMD("set_tempo", { bpm: 90 })] },
        { goal: "b", commands: [CMD("set_tempo", { bpm: 91 })] },
      ] },
    ]);
    const base = scriptedEnv(["ok", "ok"]);
    const env = {
      ...base.env,
      async runBatch(label: string, calls: readonly { command: string }[]) {
        signal.aborted = true; // user hits Stop while the first batch runs
        return base.env.runBatch(label, calls);
      },
    };
    const run = await runAgentLoop({ ask: "x" }, { chat, env, signal } as LoopDeps);

    expect(run.outcome).toBe("aborted");
    expect(run.stepCount).toBe(1);
    expect(base.batches).toHaveLength(1);
  });

  it("a planning-call crash reports outcome error, never a silent empty done", async () => {
    const chat = async () => { throw new Error("socket down"); };
    const { env } = scriptedEnv([]);
    const run = await runAgentLoop({ ask: "x" }, { chat, env } as LoopDeps);

    expect(run.outcome).toBe("error");
    expect(run.error).toMatch(/socket down/);
    expect(run.deferred).toBe(true);
  });

  it("defaults are the approved budgets", () => {
    expect(DEFAULT_LOOP_BUDGETS).toMatchObject({ maxSteps: 8, maxPlannerCalls: 3, maxStepCalls: 8 });
  });
});

describe("runAgentLoop — M2 deps.memory forwarding", () => {
  // deps.memory is a pre-rendered string the app-side glue (runTask.ts) computes
  // ONCE before the loop starts — the FSM itself never calls the bridge. This proves
  // the FSM actually threads it into buildLoopSystemPrompt on EVERY model call
  // (plan + any repair/continue), not just the first.
  function scriptedChatCapturingSystem(replies: Array<Record<string, unknown> | string>) {
    const systemSeen: string[] = [];
    return {
      systemSeen,
      chat: async (messages: Array<{ role: string; content: string }>) => {
        systemSeen.push(messages[0]!.content);
        const next = replies.shift();
        if (next === undefined) throw new Error("scripted chat exhausted");
        return { content: typeof next === "string" ? next : JSON.stringify(next), ms: 1 };
      },
    };
  }

  it("an omitted deps.memory never adds a Memory section to the system prompt", async () => {
    const { chat, systemSeen } = scriptedChatCapturingSystem([
      { status: "done", commands: [] },
    ]);
    const { env } = scriptedEnv(["ok"]);
    await runAgentLoop({ ask: "x" }, { chat, env } as LoopDeps);
    expect(systemSeen[0]).not.toContain("Memory —");
  });

  it("a provided deps.memory appears in EVERY model call's system prompt (plan AND a follow-up repair call)", async () => {
    const { chat, systemSeen } = scriptedChatCapturingSystem([
      { status: "continue", plan: [{ goal: "a" }] },   // plan call — no commands, needs a compile
      { status: "done", commands: [CMD("set_tempo", { bpm: 90 })] },  // compile call for step "a"
    ]);
    const { env } = scriptedEnv(["ok"]);
    const run = await runAgentLoop({ ask: "x" }, {
      chat, env, memory: "Memory — a made-up section.\n- (this project) a fact",
    } as LoopDeps);

    expect(run.outcome).toBe("done");
    expect(systemSeen.length).toBeGreaterThanOrEqual(2);
    for (const sys of systemSeen) expect(sys).toContain("Memory — a made-up section.");
  });
});
