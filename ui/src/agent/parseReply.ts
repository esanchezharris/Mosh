// Pure parser for the brain's reply — pulls ONE JSON object out of whatever prose
// the LLM returns. Deliberately free of any bridge / JUCE / store imports so it can
// be unit-tested in plain node (the rest of brain.ts drags in the WebView bridge).
import type { AgentCommandCall } from "./executor";

export type BrainReply = { say?: string; intent?: string; commands?: AgentCommandCall[]; mocked?: boolean };

export function parseReply(content: string): BrainReply {
  let s = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as BrainReply;
    return {
      say: typeof o.say === "string" ? o.say : undefined,
      intent: typeof o.intent === "string" ? o.intent : undefined,
      commands: Array.isArray(o.commands) ? o.commands.filter((c) => c && typeof c.command === "string") : undefined,
    };
  } catch {
    return { say: undefined, intent: "HUH" };
  }
}
