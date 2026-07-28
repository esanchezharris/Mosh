// Today's shipped brain shape as an AgentRunner: ONE production system prompt
// over the start snapshot → one model call → parse → execute as one batch.
// The `repair` variant adds ONE error-fed fix turn (observable signals only —
// the model sees its own command errors, never the gold checks): the measured
// pattern that took beat-building 0/9 → 9/9 in the 2026-07 audit, and the
// cheap preview of the Phase-B loop's headroom.
//
// This is the BASELINE runner. The Phase-B agentic loop exports the same
// AgentRunner shape and slots in as `--runner loop` with zero bench changes.

import { buildSystemPrompt, DEFAULT_RULES, parseReply } from "../agent/brainCore";
import { validateCommand } from "../agent/commands";
import type { AgentCommandCall } from "../agent/executor";
import type { AgentRunner, StepRecord } from "../agent/loopSeam";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatFn = (messages: ChatMessage[]) => Promise<{ content: string; ms?: number }>;

export type SingleShotDeps = {
  chat: ChatFn;
  /** Allow ONE error-driven repair turn after a failed command. */
  repair?: boolean;
  /** Rules block override (defaults to the shipped DEFAULT_RULES). */
  rules?: string;
};

const toCalls = (reply: ReturnType<typeof parseReply>): AgentCommandCall[] =>
  (reply.commands ?? []).map((c) => ({ command: c.command, args: c.args ?? {} }));

const countInvalid = (calls: readonly AgentCommandCall[]): number =>
  calls.filter((c) => validateCommand(c.command, (c.args ?? {}) as Record<string, unknown>) !== null).length;

export function makeSingleShotRunner(deps: SingleShotDeps): AgentRunner {
  return async (task, env) => {
    const transcript: StepRecord[] = [];
    let snapshot = await env.getSnapshot();
    const system = buildSystemPrompt(deps.rules ?? DEFAULT_RULES, snapshot);
    // Prior turns sit between the system block and this turn's ask — the same
    // placement the shipped brain uses (agent/brain.ts keeps `history.slice(-8)`
    // after the system message). With no history the array is byte-identical to
    // the pre-conversation shape, so single-turn scoreboards stay comparable.
    const base: ChatMessage[] = [
      { role: "system", content: system },
      ...(task.history ?? []).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: "user", content: task.ask },
    ];

    let content = "";
    let ms = 0;
    let error: string | undefined;
    try {
      const r = await deps.chat(base);
      content = r.content;
      ms = r.ms ?? 0;
    } catch (e) {
      error = String(e).slice(0, 200);
    }

    const reply = error ? ({} as ReturnType<typeof parseReply>) : parseReply(content);
    const commands = toCalls(reply);
    let results: StepRecord["results"] = [];
    if (commands.length > 0) {
      const out = await env.runBatch(`agent-bench: ${task.ask.slice(0, 48)}`, commands);
      results = out.results;
      snapshot = out.snapshot;
    }
    transcript.push({ say: reply.say, intent: reply.intent, commands, results, invalidCount: countInvalid(commands), ms });

    if (deps.repair && results.some((r) => !r.ok)) {
      const errs = results.filter((r) => !r.ok).map((r) => `${r.command}: ${r.error ?? "failed"}`).join("; ");
      try {
        const r2 = await deps.chat([
          ...base,
          { role: "assistant", content },
          { role: "user", content: `Some of those commands failed: ${errs}. Reply with ONLY the corrected commands (same JSON contract).` },
        ]);
        const fixReply = parseReply(r2.content);
        const fixes = toCalls(fixReply);
        let fixResults: StepRecord["results"] = [];
        if (fixes.length > 0) {
          const out = await env.runBatch("agent-bench repair", fixes);
          fixResults = out.results;
          snapshot = out.snapshot;
        }
        transcript.push({
          say: fixReply.say, intent: fixReply.intent, commands: fixes,
          results: fixResults, invalidCount: countInvalid(fixes), ms: r2.ms ?? 0,
        });
      } catch {
        /* the repair call failed — keep the first shot's results */
      }
    }

    const deferred = transcript.every((s) => s.commands.length === 0);
    return { finalSnapshot: snapshot, transcript, stepCount: transcript.length, deferred, error };
  };
}
