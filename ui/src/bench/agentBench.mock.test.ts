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
import { AGENT_TASKS, taskById } from "./agentTasks";
import { scoreTask, grade } from "./goalChecks";
import { makeSingleShotRunner, type ChatMessage } from "./singleShotRunner";
import { makeMockEnv, runMockSetup } from "./mockEnv";
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
    for (const cat of ["arrange", "compose-drums", "compose-melody", "mix", "master", "generative", "lyrics", "repair", "ambiguous"])
      expect(byCat[cat], `category ${cat}`).toBeGreaterThanOrEqual(2);
    expect(AGENT_TASKS.length).toBeGreaterThanOrEqual(28);
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
