// MoshAgentBench — harness smoke on the MOCK substrate. A scripted fake brain
// (no network) drives a handful of tasks end-to-end through the production
// executor path (validateCommand → screenDestructive → batch_begin/…/batch_end
// via runAgentBatch → the dev mock), pinning: predicate evaluation, step
// accounting, defer detection, wrong-defer flagging, destructive screening and
// the single-repair ladder. The mock NEVER gates a model verdict — this suite
// gates only the bench's own correctness (the real-engine runner is the gate).

import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { AGENT_TASKS, CONVERSATIONAL_TASKS, SINGLE_TURN_TASKS, suiteTasks, taskById } from "./agentTasks";
import { scoreTask, grade } from "./goalChecks";
import { makeSingleShotRunner, type ChatMessage } from "./singleShotRunner";
import { makeLoopRunner } from "./loopRunner";
import { makeMockEnv, runMockSetup } from "./mockEnv";
import { runConversation } from "./conversation";
import type { AgentRunner } from "../agent/loopSeam";
import { AGENT_COMMAND_MAP } from "../agent/commands";

// A scripted brain: pops replies off a queue (JSON strings, exactly what a
// provider would return). Records the messages it saw for asserting feedback.
function scriptedChat(replies: string[]) {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    chat: async (messages: ChatMessage[]) => {
      seen.push(messages);
      const content = replies.shift();
      if (content === undefined) throw new Error("scripted brain ran out of replies");
      return { content, ms: 1 };
    },
  };
}

async function freshEnvFor(taskId: string) {
  __resetMockForTests();
  await useStore.getState().refresh();
  const task = taskById(taskId);
  const vars = await runMockSetup(task.setup);
  const env = makeMockEnv();
  const before = await env.getSnapshot();
  return { task, env, before, vars };
}

describe("agent task suite — static sanity", () => {
  it("task ids are unique and pars are positive on action tasks", () => {
    const ids = AGENT_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of AGENT_TASKS) {
      if (t.ambiguous) expect(t.par).toBe(0);
      else expect(t.par, `${t.id} par`).toBeGreaterThan(0);
    }
  });

  it("covers every category with multiple tasks", () => {
    const byCat: Record<string, number> = {};
    for (const t of AGENT_TASKS) byCat[t.category] = (byCat[t.category] ?? 0) + 1;
    for (const cat of [
      "arrange", "compose-drums", "compose-melody", "mix", "master", "generative", "lyrics", "repair", "ambiguous",
      "converse-clarify", "converse-correct", "converse-session", "converse-recover",
    ])
      expect(byCat[cat], `category ${cat}`).toBeGreaterThanOrEqual(2);
    expect(AGENT_TASKS.length).toBeGreaterThanOrEqual(28);
  });

  it("the single-turn suite is EXACTLY the historical 34 (scoreboard comparability)", () => {
    // The number every board from 2026-07-18 onward is a percentage of. If a
    // conversational task ever leaks into this suite, every historical comparison
    // silently shifts while still looking like the same metric.
    expect(SINGLE_TURN_TASKS).toHaveLength(34);
    expect(SINGLE_TURN_TASKS.every((t) => !t.followUps)).toBe(true);
    expect(CONVERSATIONAL_TASKS.every((t) => t.category.startsWith("converse-"))).toBe(true);
    expect(suiteTasks("single")).toEqual(SINGLE_TURN_TASKS);
    expect(suiteTasks("all")).toEqual(AGENT_TASKS);
  });

  it("conversational tasks are well-formed: follow-ups, turn-addressed goals in range", () => {
    for (const t of CONVERSATIONAL_TASKS) {
      const turns = 1 + (t.followUps?.length ?? 0);
      expect(turns, `${t.id} needs >1 turn`).toBeGreaterThan(1);
      expect(t.ambiguous, `${t.id} must not also be an ambiguous task`).toBeFalsy();
      for (const g of t.goals) {
        const k = (g as { kind: string }).kind;
        if (k === "askedAtTurn" || k === "actedAtTurn" || k === "noCommandsBeforeTurn") {
          const turn = (g as { turn: number }).turn;
          // A goal addressing a turn that never runs would be unsatisfiable —
          // a task that can only ever fail looks exactly like a hard task.
          expect(turn, `${t.id} ${k} turn ${turn} out of range (${turns} turns)`).toBeLessThan(turns);
          expect(turn).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("every setup command is agent-callable (keeps setups replayable on both substrates)", () => {
    for (const t of AGENT_TASKS)
      for (const c of t.setup)
        expect(AGENT_COMMAND_MAP.has(c.command), `${t.id} setup uses non-catalog "${c.command}"`).toBe(true);
  });

  it("ambiguous tasks carry exactly the defer goal", () => {
    for (const t of AGENT_TASKS.filter((x) => x.ambiguous))
      expect(t.goals).toEqual([{ kind: "defer" }]);
  });
});

describe("single-shot runner on the mock env (production executor path)", () => {
  beforeEach(() => __resetMockForTests());

  it("compose task: scripted 2-command reply → goals pass, stepEff 1", async () => {
    const { task, env, before } = await freshEnvFor("drums-boombap");
    const { chat } = scriptedChat([
      JSON.stringify({
        intent: "ACK_GOT_IT",
        say: "boom bap coming up",
        commands: [
          { command: "set_tempo", args: { bpm: 90 } },
          { command: "add_drum_pattern", args: { pattern: "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x." } },
        ],
      }),
    ]);
    const run = await makeSingleShotRunner({ chat })(task, env, { maxSteps: 4 });

    expect(run.stepCount).toBe(1);
    expect(run.deferred).toBe(false);
    expect(run.transcript[0].results.every((r) => r.ok)).toBe(true);

    const score = scoreTask(task, before, run);
    expect(score.checks.filter((c) => !c.pass).map((c) => c.note)).toEqual([]);
    expect(score.success).toBe(true);
    expect(score.stepEff).toBe(1);
    expect(score.cmdErrRate).toBe(0);
    expect(score.wrongDefer).toBe(false);
  });

  it("ambiguous task: HUH with zero commands → deferCorrect, success", async () => {
    const { task, env, before } = await freshEnvFor("amb-make-better");
    const { chat } = scriptedChat([JSON.stringify({ intent: "HUH", say: "better how — louder, busier, moodier?" })]);
    const run = await makeSingleShotRunner({ chat })(task, env, { maxSteps: 4 });

    expect(run.deferred).toBe(true);
    const score = scoreTask(task, before, run);
    expect(score.success).toBe(true);
    expect(score.deferCorrect).toBe(true);
  });

  it("action task deferred → wrongDefer flagged, no success", async () => {
    const { task, env, before } = await freshEnvFor("mix-balance");
    const { chat } = scriptedChat([JSON.stringify({ intent: "HUH", say: "which drums?" })]);
    const run = await makeSingleShotRunner({ chat })(task, env, { maxSteps: 4 });

    const score = scoreTask(task, before, run);
    expect(score.success).toBe(false);
    expect(score.wrongDefer).toBe(true);
  });

  it("failed command surfaces in cmdErrRate and fails the task", async () => {
    const { task, env, before } = await freshEnvFor("mix-balance");
    const { chat } = scriptedChat([
      JSON.stringify({
        intent: "ACK_GOT_IT",
        commands: [{ command: "set_track_volume", args: { trackId: "no-such-track", db: -3 } }],
      }),
    ]);
    const run = await makeSingleShotRunner({ chat })(task, env, { maxSteps: 4 });

    const score = scoreTask(task, before, run);
    expect(score.success).toBe(false);
    expect(score.cmdErrRate).toBeGreaterThan(0);
  });

  it("destructive screen holds on the bench path: delete_time_range + remove_clip both blocked", async () => {
    const { task, env } = await freshEnvFor("arr-clear-middle");
    const { chat } = scriptedChat([
      JSON.stringify({
        intent: "ACK_GOT_IT",
        commands: [
          { command: "delete_time_range", args: { start: 4, end: 8 } },
          { command: "remove_clip", args: { clipId: "c1" } },
        ],
      }),
    ]);
    const run = await makeSingleShotRunner({ chat })(task, env, { maxSteps: 4 });

    expect(run.transcript[0].results).toHaveLength(2);
    expect(run.transcript[0].results.every((r) => !r.ok)).toBe(true);
    expect(run.transcript[0].results.every((r) => /Blocked: too many destructive/.test(r.error ?? ""))).toBe(true);
  });

  it("single-repair runner: a failed command gets ONE error-fed fix turn", async () => {
    const { task, env, before } = await freshEnvFor("mix-balance");
    const { chat, seen } = scriptedChat([
      JSON.stringify({
        intent: "ACK_GOT_IT",
        commands: [
          { command: "set_track_volume", args: { trackId: "bogus", db: -3 } },
          { command: "set_track_pan", args: { trackId: "${KEYS_ID_IS_UNKNOWN}", pan: 0.2 } },
        ],
      }),
      // The repair turn: the scripted brain "reads" the errors and fixes both.
      JSON.stringify({
        intent: "ACK_GOT_IT",
        commands: [
          { command: "set_track_volume", args: { trackId: "%DRUMS%", db: -3 } },
          { command: "set_track_pan", args: { trackId: "%KEYS%", pan: 0.2 } },
        ],
      }),
    ]);

    // Resolve the real ids into the scripted fix (a scripted brain can't read the
    // snapshot, so the test injects them — the point is the LADDER, not the model).
    const snap = await env.getSnapshot();
    const drums = snap.tracks.find((t) => t.name === "Drums")!.id;
    const keys = snap.tracks.find((t) => t.name === "Keys")!.id;
    const patchedChat = async (messages: ChatMessage[]) => {
      const r = await chat(messages);
      return { ...r, content: r.content.replace("%DRUMS%", drums).replace("%KEYS%", keys) };
    };

    const run = await makeSingleShotRunner({ chat: patchedChat, repair: true })(task, env, { maxSteps: 4 });

    expect(run.transcript).toHaveLength(2); // first shot + one repair turn
    const last = seen[seen.length - 1];
    expect(last[last.length - 1].content).toMatch(/failed/i); // errors were fed back
    expect(run.transcript[1].results.every((r) => r.ok)).toBe(true);

    const score = scoreTask(task, before, run);
    expect(score.checks.filter((c) => !c.pass).map((c) => c.note)).toEqual([]);
    expect(score.success).toBe(true);
  });
});

describe("goal predicates against real mock state", () => {
  beforeEach(() => __resetMockForTests());

  it("timeRangeEmpty / clipField / tempoMapPoint / masterChainContains grade real snapshots", async () => {
    const { env, before } = await freshEnvFor("arr-clear-middle");
    // Manually clear the range through the seam, then grade.
    const { snapshot: after } = await env.runBatch("clear", [
      { command: "delete_time_range", args: { start: 4, end: 8 } },
    ]);
    expect(grade({ kind: "timeRangeEmpty", startSec: 4, endSec: 8 }, before, after, []).pass).toBe(true);
    expect(grade({ kind: "timeRangeEmpty", startSec: 0, endSec: 2 }, before, after, []).pass).toBe(false);

    const { snapshot: after2 } = await env.runBatch("more", [
      { command: "insert_tempo_change", args: { time: 10, bpm: 140 } },
      { command: "load_master_builtin", args: { type: "compressor" } },
    ]);
    expect(grade({ kind: "tempoMapPoint", time: 10, bpm: 140 }, before, after2, []).pass).toBe(true);
    expect(grade({ kind: "tempoMapPoint", time: 10, negate: true }, before, after2, []).pass).toBe(false);
    expect(grade({ kind: "masterChainContains", nameIncludes: "comp" }, before, after2, []).pass).toBe(true);
    expect(grade({ kind: "masterChainOrder", first: "comp", then: "limiter" }, before, after2, []).pass).toBe(false);
  });

  it("notesInKey grades a bassline against the session key", async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    const vars = await runMockSetup([
      { command: "set_key", args: { tonic: "A", mode: "minor" } },
      { command: "create_track", args: { name: "Bassline" }, capture: { TB: "trackId" } },
      { command: "add_midi_clip", args: { trackId: "${TB}", start: 0, length: 4 }, capture: { CB: "clipId" } },
    ]);
    const env = makeMockEnv();
    const before = await env.getSnapshot();
    // A, C, E, G — all in A minor; then one F# (out of key for A natural minor... F#
    // is in A dorian, NOT A minor's scale set [0,2,3,5,7,8,10] → 9 is out).
    const inKey = [57, 60, 64, 67];
    const { snapshot: after } = await env.runBatch("notes", [
      ...inKey.map((pitch, i) => ({ command: "add_note", args: { clipId: vars.CB, pitch, start: i, length: 0.5 } })),
    ]);
    expect(grade({ kind: "notesInKey", track: "Bassline", tonic: "A", mode: "minor", minNotes: 4, requireAll: true }, before, after, []).pass).toBe(true);

    const { snapshot: after2 } = await env.runBatch("outlier", [
      { command: "add_note", args: { clipId: vars.CB, pitch: 66, start: 4, length: 0.5 } }, // F#
    ]);
    expect(grade({ kind: "notesInKey", track: "Bassline", tonic: "A", mode: "minor", minNotes: 4, requireAll: true }, before, after2, []).pass).toBe(false);
    expect(grade({ kind: "notesInKey", track: "Bassline", tonic: "A", mode: "minor", minNotes: 4 }, before, after2, []).pass).toBe(true);
  });

  it("netTrackLevelDelta sees fader + clip gain together (the repair-task metric)", async () => {
    const { env, before } = await freshEnvFor("rep-clipping-808");
    const snap = await env.getSnapshot();
    const t808 = snap.tracks.find((t) => t.name === "808")!;
    const clip = t808.clips[0];
    const { snapshot: after } = await env.runBatch("fix", [
      { command: "set_track_volume", args: { trackId: t808.id, db: 4 } },  // 9 → 4 (down 5)
      { command: "set_clip_gain", args: { clipId: clip.id, gainDb: 6 } },  // 12 → 6 (down 6)
    ]);
    expect(grade({ kind: "netTrackLevelDelta", track: "808", dir: "down", minDb: 6 }, before, after, []).pass).toBe(true);
    expect(grade({ kind: "netTrackLevelDelta", track: "808", dir: "down", minDb: 20 }, before, after, []).pass).toBe(false);
  });
});

describe("conversational tasks — the multi-turn driver", () => {
  beforeEach(() => __resetMockForTests());

  it("a task with no followUps is ONE runner call with no history (scoreboard comparability)", async () => {
    // The load-bearing equivalence: every scoreboard recorded before conversations
    // existed must still mean the same thing. If this breaks, all prior numbers are
    // silently incomparable to all later ones.
    const { task, env } = await freshEnvFor("mix-balance");
    const calls: Array<{ ask: string; history?: readonly unknown[] }> = [];
    const runner: AgentRunner = async (t, e) => {
      calls.push({ ask: t.ask, history: t.history });
      return { finalSnapshot: await e.getSnapshot(), transcript: [], stepCount: 0, deferred: true };
    };
    await runConversation(task, runner, env, { maxSteps: 4 });

    expect(calls).toHaveLength(1);
    expect(calls[0].ask).toBe(task.ask);
    expect(calls[0].history ?? []).toEqual([]);
  });

  it("drives each turn with the prior turns as history, and stamps steps with their turn", async () => {
    const { task, env } = await freshEnvFor("conv-clarify-louder");
    const snap = await env.getSnapshot();
    const drums = snap.tracks.find((t) => t.name === "Drums")!.id;

    // Turn 0 asks; turn 1 acts. Exactly the behaviour the category rewards.
    const { chat } = scriptedChat([
      JSON.stringify({ intent: "HUH", say: "which track — drums, 808, keys or the vocal?" }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: drums, db: 3 } }] }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    expect(run.transcript.map((s) => s.turn)).toEqual([0, 1]);
    expect(run.transcript[0].commands).toHaveLength(0);
    expect(run.transcript[1].results.every((r) => r.ok)).toBe(true);
    // Asked THEN acted is not a deferral — the whole point of the category.
    expect(run.deferred).toBe(false);
  });

  it("the second turn's prompt actually carries turn 0 (history threading)", async () => {
    const { task, env } = await freshEnvFor("conv-clarify-louder");
    const snap = await env.getSnapshot();
    const drums = snap.tracks.find((t) => t.name === "Drums")!.id;
    const { chat, seen } = scriptedChat([
      JSON.stringify({ intent: "HUH", say: "which track?" }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: drums, db: 3 } }] }),
    ]);
    await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    expect(seen).toHaveLength(2);
    const second = seen[1]!;
    // system + user(turn0) + assistant(turn0 reply) + user(turn1)
    expect(second).toHaveLength(4);
    expect(second[1]).toEqual({ role: "user", content: task.ask });
    expect(second[2].role).toBe("assistant");
    expect(second[2].content).toContain("which track?");
    expect(second[3].content).toBe(task.followUps![0].say);
  });

  it("an acting turn replays its COMMANDS to the next turn, so 'undo that' has a referent", async () => {
    const { task, env } = await freshEnvFor("conv-correct-undo");
    const snap = await env.getSnapshot();
    const keysClip = snap.tracks.find((t) => t.name === "Keys")!.clips[0].id;
    const { chat, seen } = scriptedChat([
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "duplicate_clip", args: { clipId: keysClip } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "undo", args: {} }] }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    const assistantMsg = seen[1]!.find((m) => m.role === "assistant")!.content;
    expect(assistantMsg).toContain("duplicate_clip");   // it can see WHAT it did
    expect(run.transcript.map((s) => s.turn)).toEqual([0, 1]);
  });

  it("scores the clarify shape end-to-end: asked@0 + acted@1 + the state goal", async () => {
    const { task, env, before } = await freshEnvFor("conv-clarify-louder");
    const snap = await env.getSnapshot();
    const drums = snap.tracks.find((t) => t.name === "Drums")!.id;
    const { chat } = scriptedChat([
      JSON.stringify({ intent: "HUH", say: "which track?" }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: drums, db: 3 } }] }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    const score = scoreTask(task, before, run);
    expect(score.checks.filter((c) => !c.pass).map((c) => c.note)).toEqual([]);
    expect(score.success).toBe(true);
    expect(score.wrongDefer).toBe(false);
  });

  it("acting on turn 0 instead of asking FAILS the clarify task (the whole point)", async () => {
    // An agent that guesses "louder" means the drums gets the state right and the
    // BEHAVIOUR wrong. Without askedAtTurn this would score as a clean pass.
    const { task, env, before } = await freshEnvFor("conv-clarify-louder");
    const snap = await env.getSnapshot();
    const drums = snap.tracks.find((t) => t.name === "Drums")!.id;
    const { chat } = scriptedChat([
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: drums, db: 3 } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", say: "already done" }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    const score = scoreTask(task, before, run);
    expect(score.success).toBe(false);
    expect(score.checks.find((c) => (c.check as { kind: string }).kind === "askedAtTurn")!.pass).toBe(false);
    // ...and the state goal it "got right" still passed — proving the failure came
    // from the behavioural check, not from the task being unsatisfiable.
    expect(score.checks.find((c) => (c.check as { kind: string }).kind === "trackDelta")!.pass).toBe(true);
  });

  it("noCommandsBeforeTurn catches a half-guess made before the answer arrived", async () => {
    const { task, env, before } = await freshEnvFor("conv-clarify-two-step");
    const snap = await env.getSnapshot();
    const t808 = snap.tracks.find((t) => t.name === "808")!.id;
    const { chat } = scriptedChat([
      JSON.stringify({ intent: "HUH", say: "clean up what — levels, timing, arrangement?" }),
      // Turn 1: jumps the gun and starts moving faders before being told which.
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: t808, db: -4 } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", say: "already balanced" }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    const score = scoreTask(task, before, run);
    expect(score.checks.find((c) => (c.check as { kind: string }).kind === "noCommandsBeforeTurn")!.pass).toBe(false);
    expect(score.success).toBe(false);
  });

  it("conv-recover-clipping PASSES the correct fix — restoring the level it boosted", async () => {
    // Regression pin for a task-design bug caught live on 2026-07-27: the first draft
    // required the 808 to end 5 dB BELOW its original level, so a run that correctly
    // undid its own +10 boost (ending at 0) was scored a failure while nothing could
    // pass. A task that punishes the right answer is indistinguishable from a hard
    // task on a scoreboard, which is exactly why this is pinned rather than eyeballed.
    const { task, env, before } = await freshEnvFor("conv-recover-clipping");
    const snap = await env.getSnapshot();
    const t808 = snap.tracks.find((t) => t.name === "808")!.id;
    const { chat } = scriptedChat([
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: t808, db: 10 } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: t808, db: 0 } }] }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    const score = scoreTask(task, before, run);
    expect(score.checks.filter((c) => !c.pass).map((c) => c.note)).toEqual([]);
    expect(score.success).toBe(true);
  });

  it("conv-recover-clipping FAILS a half-fix that leaves the track hot", async () => {
    // The other side of the band: +10 then only down to +6 is not a fix. Without this
    // the task would pass anything that moved the fader in the right direction.
    const { task, env, before } = await freshEnvFor("conv-recover-clipping");
    const snap = await env.getSnapshot();
    const t808 = snap.tracks.find((t) => t.name === "808")!.id;
    const { chat } = scriptedChat([
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: t808, db: 10 } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_track_volume", args: { trackId: t808, db: 6 } }] }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });
    expect(scoreTask(task, before, run).success).toBe(false);
  });

  it("conv-session-beat's final turn is reachable in ONE reply (no id-chaining)", async () => {
    // The other 2026-07-27 design bug: the first draft asked a single-shot seat to
    // create a track, add a clip to it, and add notes to that clip in one reply —
    // impossible, since the ids don't exist until the earlier commands run. Seeding
    // the Bass track + clip makes the last turn pure add_note, which this proves by
    // playing exactly that and requiring the key goal to pass.
    const { task, env, before } = await freshEnvFor("conv-session-beat");
    const snap = await env.getSnapshot();
    const clip = snap.tracks.find((t) => t.name === "Bass")!.clips[0].id;
    const notes = [45, 48, 52, 55]; // A2 C3 E3 G3 — all in A minor
    const { chat } = scriptedChat([
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_tempo", args: { bpm: 92 } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "add_drum_pattern", args: { pattern: "kick: x...x...; snare: ....x...; hat: x.x.x.x." } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: [{ command: "set_key", args: { tonic: "A", mode: "minor" } }] }),
      JSON.stringify({ intent: "ACK_GOT_IT", commands: notes.map((pitch, i) => ({ command: "add_note", args: { clipId: clip, pitch, start: i, length: 0.5 } })) }),
    ]);
    const run = await runConversation(task, makeSingleShotRunner({ chat }), env, { maxSteps: 4 });

    const score = scoreTask(task, before, run);
    expect(score.checks.filter((c) => !c.pass).map((c) => c.note)).toEqual([]);
    expect(score.success).toBe(true);
  });

  it("a brain error ends the conversation instead of replaying more turns at it", async () => {
    const { task, env } = await freshEnvFor("conv-clarify-louder");
    let calls = 0;
    const runner: AgentRunner = async (_t, e) => {
      calls++;
      return { finalSnapshot: await e.getSnapshot(), transcript: [], stepCount: 0, deferred: true, error: "network down" };
    };
    const run = await runConversation(task, runner, env, { maxSteps: 4 });

    expect(calls).toBe(1);              // turn 1 was never sent
    expect(run.error).toBe("network down");
  });
});

describe("loop runner on the mock env — the Phase-B integration", () => {
  beforeEach(() => __resetMockForTests());

  it("mix-vocal-space: plan → observe the new bus → route + tuck, scored success", async () => {
    // The task single-shot models kept guessing at: the bus NUMBER only exists
    // after create_bus runs — the loop reads it from the observed session.
    const { task, env, before } = await freshEnvFor("mix-vocal-space");
    const snap0 = await env.getSnapshot();
    const vocal = snap0.tracks.find((t) => t.name === "Vocal")!.id;
    const drums = snap0.tracks.find((t) => t.name === "Drums")!.id;

    // Reply 2 is computed FROM the observed session block — the scripted brain
    // reads the bus number the loop showed it, exactly what a real model does
    // (and what single-shot structurally cannot: the number exists only after
    // create_bus runs — both substrates allocate from 0, so a "bus 1" guess
    // fails; the observation is the only honest source).
    const seen: ChatMessage[][] = [];
    const chat = async (messages: ChatMessage[]) => {
      seen.push(messages);
      if (seen.length === 1)
        return { content: JSON.stringify({
          intent: "ACK_WORKING", say: "making room", status: "continue",
          plan: [
            { goal: "create the reverb return", commands: [{ command: "create_bus", args: { name: "Reverb" } }] },
            { goal: "send the vocal into it and tuck the drums" },
          ],
        }), ms: 1 };
      const observedBus = messages[0]!.content.match(/buses: (\d+) "Reverb"/)?.[1];
      expect(observedBus, "the rich session block must carry the new bus").toBeDefined();
      return { content: JSON.stringify({
        intent: "ACK_GOT_IT", status: "done",
        commands: [
          { command: "add_send", args: { trackId: vocal, bus: Number(observedBus), db: -10 } },
          { command: "set_track_volume", args: { trackId: drums, db: -2 } },
        ],
      }), ms: 1 };
    };

    const run = await makeLoopRunner({ chat })(task, env, { maxSteps: 8 });
    expect(run.transcript.every((s) => s.results.every((r) => r.ok))).toBe(true);
    expect(run.stepCount).toBe(2);
    expect(seen).toHaveLength(2);
    // the second call's SYSTEM prompt carried the observed bus (0-allocated
    // on both substrates) — the rich block IS the observation
    expect(seen[1]![0]!.content).toContain('buses: 0 "Reverb"');

    const score = scoreTask(task, before, run);
    expect(score.checks.filter((c) => !c.pass).map((c) => c.note)).toEqual([]);
    expect(score.success).toBe(true);
    expect(score.stepEff).toBe(1); // par 2, steps 2
  });
});
