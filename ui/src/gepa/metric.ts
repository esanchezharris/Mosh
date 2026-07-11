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

/** Resolve ${VAR} utterance placeholders from the env `runBound` populated —
 *  the same vars the row's startCommands bind — so the model is always shown an
 *  id that exists in its rendered snapshot (frozen-eval id fix, 2026-07-10; see
 *  fixtureIds.ts). Unknown vars are left intact: the eval builder's gap check
 *  (buildEvalV2A.mts) owns that failure at build time. */
export function resolveUtterance(utterance: string, env: Map<string, string>): string {
  return utterance.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, v: string) => env.get(v) ?? m);
}

/** multiset recall of `gold` names covered by `got` names (0..1). The strict
 *  primitive — content-batch tasks (note population) should use fairRecall. */
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

/** A "short pattern" — the most notes a populate ask ("write a short pattern")
 *  is fairly required to produce. A one-bar 8th-note figure. Beyond this, more
 *  notes neither help nor hurt the content score. */
export const SHORT_PATTERN_NOTES = 8;

/** Content-fair recall: like nameRecall, but the required multiplicity of any one
 *  command name is capped at SHORT_PATTERN_NOTES. Deterministic ops (gold count 1)
 *  grade identically; a note-population gold of N `add_note`s only requires a short
 *  pattern's worth — so "write a short pattern" is no longer graded against the
 *  source clip's exact note count (the bug that zeroed valid short patterns). */
export function fairRecall(gold: string[], got: string[]): number {
  if (gold.length === 0) return 1;
  const need = new Map<string, number>();
  for (const g of gold) need.set(g, (need.get(g) ?? 0) + 1);
  const gotCount = new Map<string, number>();
  for (const c of got) gotCount.set(c, (gotCount.get(c) ?? 0) + 1);
  let required = 0;
  let covered = 0;
  for (const [name, n] of need) {
    const req = Math.min(n, SHORT_PATTERN_NOTES);
    required += req;
    covered += Math.min(gotCount.get(name) ?? 0, req);
  }
  return required === 0 ? 1 : covered / required;
}

/** Score one example: set up its start state, render the candidate `rules` +
 *  snapshot to the brain, then grade the emitted commands. `catalog` swaps the
 *  command catalog in the prompt (small-model-mode arm); omitted = full catalog. */
export async function scoreExample(
  rules: string,
  ex: EvalExample,
  callBrain: CallBrain,
  catalog?: string,
): Promise<ExampleScore> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  await runBound(ex.startCommands, env);
  const snapshotBefore = await mockSnapshot<Snapshot>();
  const utterance = resolveUtterance(ex.utterance, env);

  let content = "";
  try {
    content = await callBrain([
      { role: "system", content: buildSystemPrompt(rules, snapshotBefore, catalog) },
      { role: "user", content: utterance },
    ]);
  } catch { content = ""; }

  const cmds = parseReply(content).commands ?? [];
  if (cmds.length === 0) {
    return { id: ex.id, score: 0, deferred: true, feedback: `DEFERRED on "${utterance}" — expected ${ex.goldCommandNames.join(", ")}` };
  }

  let ok = 0;
  const errors: string[] = [];
  for (const c of cmds) {
    const verr = validateCommand(c.command, c.args ?? {});
    if (verr) { errors.push(`${c.command}: ${verr}`); continue; }
    let res: CommandResult;
    try { res = await mockExecute<CommandResult>({ command: c.command, args: c.args ?? {} }); }
    catch (e) { errors.push(`${c.command}: threw ${String((e as Error)?.message ?? e)}`); continue; } // a command that throws in the mock (e.g. browser-only timers) = failed apply, never a crash
    if (res.ok) ok++; else errors.push(`${c.command}: ${res.error}`);
  }
  const cleanRate = ok / cmds.length;
  const recall = fairRecall(ex.goldCommandNames, cmds.map((c) => c.command));
  const score = cleanRate * recall;

  const missing = recall < 1 ? `missing ${ex.goldCommandNames.join(",")} vs got ${cmds.map((c) => c.command).join(",")}` : "";
  const feedback = [errors.length ? `apply errors: ${errors.join("; ")}` : "", missing].filter(Boolean).join(" | ") || "ok";
  return { id: ex.id, score, deferred: false, feedback };
}

// ── offline eval (dump prompts here, generate replies elsewhere, score here) ──
// For flaky/remote serving: build the exact prompts the model should answer, then
// score model replies WITHOUT a live endpoint. Same verifier, same numbers.

/** The system+user messages for an example (what a served model would receive). */
export async function buildExamplePrompt(rules: string, ex: EvalExample, catalog?: string): Promise<{ role: string; content: string }[]> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  await runBound(ex.startCommands, env);
  const snap = await mockSnapshot<Snapshot>();
  return [
    { role: "system", content: buildSystemPrompt(rules, snap, catalog) },
    { role: "user", content: resolveUtterance(ex.utterance, env) },
  ];
}

/** Score a pre-generated reply for an example (the offline analog of scoreExample). */
export async function scoreReply(ex: EvalExample, content: string): Promise<ExampleScore> {
  __resetMockForTests();
  await mockExecute<CommandResult>({ command: "new_project", args: {} });
  const env = new Map<string, string>();
  await runBound(ex.startCommands, env);
  const cmds = parseReply(content).commands ?? [];
  if (cmds.length === 0) {
    return { id: ex.id, score: 0, deferred: true, feedback: `DEFERRED on "${resolveUtterance(ex.utterance, env)}" — expected ${ex.goldCommandNames.join(", ")}` };
  }
  let ok = 0;
  const errors: string[] = [];
  for (const c of cmds) {
    const verr = validateCommand(c.command, c.args ?? {});
    if (verr) { errors.push(`${c.command}: ${verr}`); continue; }
    let res: CommandResult;
    try { res = await mockExecute<CommandResult>({ command: c.command, args: c.args ?? {} }); }
    catch (e) { errors.push(`${c.command}: threw ${String((e as Error)?.message ?? e)}`); continue; } // a command that throws in the mock (e.g. browser-only timers) = failed apply, never a crash
    if (res.ok) ok++; else errors.push(`${c.command}: ${res.error}`);
  }
  const recall = fairRecall(ex.goldCommandNames, cmds.map((c) => c.command));
  const missing = recall < 1 ? `missing ${ex.goldCommandNames.join(",")} vs got ${cmds.map((c) => c.command).join(",")}` : "";
  const feedback = [errors.length ? `apply errors: ${errors.join("; ")}` : "", missing].filter(Boolean).join(" | ") || "ok";
  return { id: ex.id, score: (ok / cmds.length) * recall, deferred: false, feedback };
}

export type EvalReport = { mean: number; deferrals: number; perExample: ExampleScore[] };

/** Score `rules` across all examples; returns the mean + per-example detail. */
export async function evaluate(rules: string, examples: EvalExample[], callBrain: CallBrain, catalog?: string): Promise<EvalReport> {
  const perExample: ExampleScore[] = [];
  for (const ex of examples) perExample.push(await scoreExample(rules, ex, callBrain, catalog));
  const mean = perExample.length ? perExample.reduce((s, e) => s + e.score, 0) / perExample.length : 0;
  const deferrals = perExample.filter((e) => e.deferred).length;
  return { mean, deferrals, perExample };
}
