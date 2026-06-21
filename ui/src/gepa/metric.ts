// GEPA reward — score a candidate rules block on an eval example using the
// Phase-0 verifier substrate (the mock backend + the agent allowlist). No audio,
// no Python, no native build, deterministic.
//
// The score targets the real failure modes the real-turn generator surfaced:
//   • deferral (the brain emits no commands when it should act) → 0
//   • apply errors (valid-looking command the engine rejects, e.g. a bad id) → penalized via clean-apply
//   • doing the wrong KIND of action → penalized via gold command-name recall
// Clean-apply implicitly enforces a valid target (a wrong id returns "track not
// found"), so the metric needs no cross-session id matching — it scores command
// NAMES (creative content like exact note pitches is not graded, by design).

import type { Snapshot, CommandResult } from "../types";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import { validateCommand } from "../agent/commands";
import { buildSystemPrompt, parseReply } from "../agent/brainCore";
import type { BoundCommand } from "../import/emit";
import type { CallBrain } from "../harvest/genTurns";
import type { EvalExample } from "./evalset";

export type ExampleScore = { id: string; score: number; deferred: boolean; feedback: string };

/** Resolve "$ref" args from `env`, run through the mock, bind results back into
 *  `env`. Operates on the CURRENT mock session (caller resets + seeds). */
export async function runBound(
  cmds: BoundCommand[],
  env: Map<string, string>,
): Promise<{ applied: number; total: number; errors: string[] }> {
  let applied = 0;
  const errors: string[] = [];
  for (const bc of cmds) {
    const args: Record<string, unknown> = {};
    let unbound = false;
    for (const [k, v] of Object.entries(bc.args)) {
      if (typeof v === "string" && v.startsWith("$")) {
        const real = env.get(v.slice(1));
        if (real === undefined) { unbound = true; break; }
        args[k] = real;
      } else args[k] = v;
    }
    if (unbound || validateCommand(bc.command, args)) { errors.push(bc.command); continue; }
    const res = await mockExecute<CommandResult>({ command: bc.command, args });
    if (res.ok) {
      applied++;
      if (bc.bind) {
        const data = (res.data ?? {}) as Record<string, unknown>;
        const id = data.trackId ?? data.clipId;
        if (typeof id === "string") env.set(bc.bind, id);
      }
    } else errors.push(`${bc.command}: ${res.error}`);
  }
  return { applied, total: cmds.length, errors };
}

/** multiset recall of `gold` names covered by `got` names (0..1). */
export function nameRecall(gold: string[], got: string[]): number {
  if (gold.length === 0) return 1;
  const need = new Map<string, number>();
  for (const g of gold) need.set(g, (need.get(g) ?? 0) + 1);
  let covered = 0;
  const seen = new Map<string, number>();
  for (const c of got) {
    const used = seen.get(c) ?? 0;
    if (used < (need.get(c) ?? 0)) { covered++; seen.set(c, used + 1); }
  }
  return covered / gold.length;
}

/** Score one example: set up its start state, render the candidate `rules` +
 *  snapshot to the brain, then grade the emitted commands. */
export async function scoreExample(
  rules: string,
  ex: EvalExample,
  callBrain: CallBrain,
): Promise<ExampleScore> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  await runBound(ex.startCommands, env);
  const snapshotBefore = await mockSnapshot<Snapshot>();

  let content = "";
  try {
    content = await callBrain([
      { role: "system", content: buildSystemPrompt(rules, snapshotBefore) },
      { role: "user", content: ex.utterance },
    ]);
  } catch { content = ""; }

  const cmds = parseReply(content).commands ?? [];
  if (cmds.length === 0) {
    return { id: ex.id, score: 0, deferred: true, feedback: `DEFERRED on "${ex.utterance}" — expected ${ex.goldCommandNames.join(", ")}` };
  }

  let ok = 0;
  const errors: string[] = [];
  for (const c of cmds) {
    const verr = validateCommand(c.command, c.args ?? {});
    if (verr) { errors.push(`${c.command}: ${verr}`); continue; }
    const res = await mockExecute<CommandResult>({ command: c.command, args: c.args ?? {} });
    if (res.ok) ok++; else errors.push(`${c.command}: ${res.error}`);
  }
  const cleanRate = ok / cmds.length;
  const recall = nameRecall(ex.goldCommandNames, cmds.map((c) => c.command));
  const score = cleanRate * recall;

  const missing = recall < 1 ? `missing ${ex.goldCommandNames.join(",")} vs got ${cmds.map((c) => c.command).join(",")}` : "";
  const feedback = [errors.length ? `apply errors: ${errors.join("; ")}` : "", missing].filter(Boolean).join(" | ") || "ok";
  return { id: ex.id, score, deferred: false, feedback };
}

export type EvalReport = { mean: number; deferrals: number; perExample: ExampleScore[] };

/** Score `rules` across all examples; returns the mean + per-example detail. */
export async function evaluate(rules: string, examples: EvalExample[], callBrain: CallBrain): Promise<EvalReport> {
  const perExample: ExampleScore[] = [];
  for (const ex of examples) perExample.push(await scoreExample(rules, ex, callBrain));
  const mean = perExample.length ? perExample.reduce((s, e) => s + e.score, 0) / perExample.length : 0;
  const deferrals = perExample.filter((e) => e.deferred).length;
  return { mean, deferrals, perExample };
}
