// The loop's OWN prompt module: the multi-step reply contract and the loop rules.
// The session render itself is NO LONGER loop-only — it moved to
// ../sessionRender.ts and the single-shot path now uses the same one (the
// master/key blind spot that cost master-trim 0/10 single-shot).

import { commandCatalogPrompt } from "../commands";
import { retrieveCards, knowledgePromptSection } from "../knowledge";
import { INTENTS } from "../brainCore";
import { renderSession } from "../sessionRender";
import type { Snapshot } from "../../types";
import type { StepRecord } from "../loopSeam";
import type { PlanStep } from "./parse";

export const LOOP_PREAMBLE = [
  "You ARE Moshi — a small, warm, playful creature, the agent living inside a music app called Mosh.",
  "You mostly communicate by emoting + a SOUND (an INTENT), not words. Only add a short `say` when a precise message is truly needed.",
  "You are working through a MULTI-STEP task: you act, you SEE the result, and you continue until it's done.",
  "Reply with ONE compact JSON object and NOTHING else:",
  `{ "intent": one of [${INTENTS.join(", ")}], "say"?: string (<=12 words), "status": "continue" | "done" | "need_user", "plan"?: [ { "goal": string, "commands"?: [...] } ], "commands"?: [ { "command": string, "args": object } ] }`,
  "You may ONLY use these commands — exact names + args (a trailing ? marks optional):",
].join("\n");

export const LOOP_RULES = [
  "Rules:",
  '- FIRST, check the ask is specific enough to act on. It must name WHAT to work on (which track, clip, section — or clearly the whole song) AND what outcome is wanted. If either is missing, so that acting means GUESSING which thing or which direction the producer meant, reply status "need_user" with one short question in `say` — no plan, no commands. A broad but clear ask is NOT a reason to ask: if you can name the target and the outcome, get on with it.',
  "- Plan first: a few short steps, never padded. Put concrete commands ON a step whenever you already know them — steps with commands run without asking you again.",
  '- Use the REAL ids from the session below for trackId/clipId. Never invent ids or commands.',
  '- trackId/clipId are STRING ids: match one from the session exactly and pass it as a JSON string, e.g. "trackId": "17" — never the bare number 17.',
  "- Each message shows the CURRENT session and the results of prior steps — trust them over memory; ids and positions may have changed since you planned.",
  "- A failed command's error is shown VERBATIM. Fix the call or route around it; never repeat a failed command unchanged.",
  '- Stop with status "done" the moment the request is satisfied.',
  '- At ANY point, if continuing means guessing at something only the producer can decide, stop with status "need_user" and ask it in `say`. Parking is a real, correct outcome — not a failure.',
  "- Stay in character. Never mention JSON, models, commands, or that you're an AI.",
].join("\n");

/** System prompt for every loop call: loop preamble + full catalog +
 *  [knowledge for the ask] + [memory] + loop rules + the RICH session. Rebuilt fresh
 *  each step (the session block is the observation) — `memory` is computed ONCE per
 *  TASK by the app-side glue (runTask.ts) before the loop starts (hydration/ranking
 *  is not a per-step cost) and passed through unchanged on every step. Omitted ⇒
 *  byte-identical to the pre-M2 shape (same guarantee as buildSystemPrompt). */
export function buildLoopSystemPrompt(snap: Snapshot | null, query?: string, memory?: string): string {
  const knowledge = query ? knowledgePromptSection(retrieveCards(query)) : "";
  const parts = [LOOP_PREAMBLE, commandCatalogPrompt()];
  if (knowledge) parts.push(knowledge);
  if (memory) parts.push(memory);
  parts.push(LOOP_RULES, "Current session:", snap ? renderSession(snap) : "(empty session)");
  return parts.join("\n");
}

export type TaskContextMode = "plan" | "compile" | "repair" | "continue";
export type TaskContext = {
  ask: string;
  plan: readonly PlanStep[];
  planIdx: number;
  history: readonly StepRecord[];
  stepsLeft: number;
  repliesLeft: number;
  mode: TaskContextMode;
  /** The goal being compiled (mode "compile"). */
  goal?: string;
};

const MODE_INSTRUCTION: Record<TaskContextMode, (c: TaskContext) => string> = {
  plan: (c) => `Is the TASK specific enough to act on — do you know WHAT to work on and WHAT outcome is wanted? If not, reply status "need_user" with one short question. Otherwise make a plan (include each step's commands when you already know them).${c.ask ? "" : ""}`,
  compile: (c) => `Give the commands for the next step: ${c.goal ?? "(unnamed)"}.`,
  repair: () => "The latest step results above include FAILURES. Fix or route around them — never repeat a failed command unchanged.",
  continue: () => 'If the TASK is complete, reply status "done". Otherwise give the next commands.',
};

export function renderTaskContext(c: TaskContext): string {
  const lines: string[] = [`TASK: ${c.ask}`];
  if (c.plan.length) {
    lines.push("PLAN:");
    c.plan.forEach((p, i) => {
      const mark = i < c.planIdx ? "✓" : i === c.planIdx ? "→" : "·";
      lines.push(`  ${mark} ${i + 1}. ${p.goal}${p.commands ? " (commands ready)" : ""}`);
    });
  }
  if (c.history.length) {
    lines.push("STEP RESULTS so far:");
    c.history.forEach((s, i) => {
      lines.push(`  step ${i + 1}:`);
      for (const r of s.results)
        lines.push(`    ${r.command} → ${r.ok ? "ok" : `ERROR: ${r.error ?? "failed"}`}`);
      if (s.results.length === 0) lines.push("    (no commands executed)");
    });
  }
  lines.push(`Budget: ${c.stepsLeft} step(s) and ${c.repliesLeft} repl${c.repliesLeft === 1 ? "y" : "ies"} left.`);
  lines.push(MODE_INSTRUCTION[c.mode](c));
  return lines.join("\n");
}
