// The loop reply contract — a superset of the single-shot BrainReply:
//   { intent, say?, status: continue|done|need_user,
//     plan?: [{goal, commands?}], commands? }
// Command normalization (function-call strings, drum-pattern object/newline
// forms, per-ArgSpec coercion) is shared with the single-shot path via
// brainCore's normalizeCommand, so a plan step benefits from every shape fix
// the baseline taught us.

import { normalizeCommand } from "../brainCore";
import type { AgentCommandCall } from "../destructiveScreen";

export type LoopStatus = "continue" | "done" | "need_user";
export type PlanStep = { goal: string; commands?: AgentCommandCall[] };
export type LoopReply = {
  intent?: string;
  say?: string;
  status: LoopStatus;
  plan?: PlanStep[];
  commands?: AgentCommandCall[];
  /** True when the content wasn't parseable JSON — the FSM parks as need_user. */
  parseFailed?: boolean;
};

function normalizeMany(v: unknown): AgentCommandCall[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(normalizeCommand).filter((c): c is AgentCommandCall => c !== null);
  return out.length ? out : undefined;
}

export function parseLoopReply(content: string): LoopReply {
  let s = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const commands = normalizeMany(o.commands);
    const plan = Array.isArray(o.plan)
      ? (o.plan as unknown[])
          .map((p) => {
            const step = (p ?? {}) as Record<string, unknown>;
            return { goal: String(step.goal ?? "").trim(), commands: normalizeMany(step.commands) };
          })
          .filter((p) => p.goal || p.commands)
      : undefined;
    const status: LoopStatus =
      o.status === "continue" || o.status === "done" || o.status === "need_user"
        ? o.status
        : commands || (plan && plan.length) ? "continue" : "done";
    return {
      intent: typeof o.intent === "string" ? o.intent : undefined,
      say: typeof o.say === "string" ? o.say : undefined,
      status,
      plan: plan && plan.length ? plan : undefined,
      commands,
    };
  } catch {
    return { status: "need_user", intent: "HUH", parseFailed: true };
  }
}
