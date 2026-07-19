// The loop's OWN prompt module. brainCore's buildSystemPrompt/compactSnapshot
// are byte-frozen for the SFT/gepa/bench consumers, so every loop-specific
// prompt element — the multi-step reply contract, the loop rules, and the RICH
// session block (master chain, buses, tempo map, key — the Phase-A visibility
// fix) — lives here, in the loop path only.

import { commandCatalogPrompt } from "../commands";
import { retrieveCards, knowledgePromptSection } from "../knowledge";
import { INTENTS } from "../brainCore";
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
  "- Plan first: a few short steps, never padded. Put concrete commands ON a step whenever you already know them — steps with commands run without asking you again.",
  '- Use the REAL ids from the session below for trackId/clipId. Never invent ids or commands.',
  '- trackId/clipId are STRING ids: match one from the session exactly and pass it as a JSON string, e.g. "trackId": "17" — never the bare number 17.',
  "- Each message shows the CURRENT session and the results of prior steps — trust them over memory; ids and positions may have changed since you planned.",
  "- A failed command's error is shown VERBATIM. Fix the call or route around it; never repeat a failed command unchanged.",
  '- Stop with status "done" the moment the request is satisfied. If you need something only the producer knows, status "need_user" and ask in `say`.',
  "- Stay in character. Never mention JSON, models, commands, or that you're an AI.",
].join("\n");

const db = (v: unknown): string => `${typeof v === "number" ? +v.toFixed(1) : 0}dB`;

/** The rich session rendering — the compact style, plus everything the
 *  baseline proved the model needs to SEE: master (the fader defaults to −3dB!),
 *  its chain, buses, the tempo map (with the indices remove_tempo_change takes),
 *  the key, and per-track pan/sends. */
export function richSessionBlock(s: Snapshot): string {
  const ses = s.session;
  const lines: string[] = [];
  lines.push(`tempo ${ses?.tempo ?? 120} BPM, ${ses?.timeSigNumerator ?? 4}/${ses?.timeSigDenominator ?? 4}`);
  const map = ses?.tempoMap;
  if (map && map.length > 1)
    lines.push(`tempo map (by index): ${map.map((p, i) => `[${i}] ${p.bpm}bpm@${p.time}s${(p.curve ?? 1) === 1 || (p.curve ?? 1) === -1 ? "" : " ramp"}`).join(", ")}`);
  if (ses?.key) lines.push(`key: ${ses.key.tonic} ${ses.key.mode}`);
  const m = s.master;
  const chain = (m?.plugins ?? []).map((p) => (p as { name?: string }).name ?? "?").join(", ");
  lines.push(`master: ${db(m?.volumeDb)} pan ${m?.pan ?? 0} chain:[${chain || "empty"}]`);
  const buses = s.buses ?? [];
  if (buses.length) lines.push(`buses: ${buses.map((b) => `${b.bus} "${b.name}"`).join(", ")}`);
  const sections = (s.sections ?? []).map((x) => `${x.id} "${x.name}" beats ${x.startBeat}-${x.endBeat}`).join("; ");
  lines.push(`sections: ${sections || "(none)"}`);
  const tracks = (s.tracks ?? [])
    .map((t) => {
      const clips = (t.clips ?? []).map((c) => `"${c.id}":${c.type}@${c.start}s`).join(", ");
      const sends = ((t as { sends?: Array<{ bus: number; db?: number }> }).sends ?? [])
        .map((x) => `bus${x.bus}@${x.db ?? 0}dB`).join(",");
      return `  "${t.id}" "${t.name}" ${t.volumeDb ?? 0}dB${t.pan ? ` pan ${t.pan}` : ""}${t.mute ? " muted" : ""}${t.solo ? " solo" : ""}${sends ? ` sends:[${sends}]` : ""} clips:[${clips}]`;
    })
    .join("\n");
  lines.push("tracks:", tracks || "  (none)");
  return lines.join("\n");
}

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
  parts.push(LOOP_RULES, "Current session:", snap ? richSessionBlock(snap) : "(empty session)");
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
  plan: (c) => `Make a plan for the TASK (include each step's commands when you already know them).${c.ask ? "" : ""}`,
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
