// Moshi's brain — turns a chat turn into a behaviour + (optionally) a list of real
// edits. It feeds the LLM a persona, the curated command catalog, and a compact
// snapshot, and asks for ONE JSON object: { intent, say?, commands? }. If the proxy
// is unreachable (no keys yet), it falls back to a tiny demo mock so the loop still
// works in the preview. Ported/extended from design-lab/playground/brain.js.

import { brainChat } from "../bridge";
import { commandCatalogPrompt } from "./commands";
import { mockBrainReply } from "./brainMock";
import type { Snapshot } from "../types";
import type { AgentCommandCall } from "./executor";

export type BrainReply = { say?: string; intent?: string; commands?: AgentCommandCall[]; mocked?: boolean };

const INTENTS = ["ACK_GOT_IT", "ACK_WORKING", "DONE", "HUH", "NUH", "UHOH", "GREET", "IDLE_MURMUR"];

function compactSnapshot(s: Snapshot): string {
  const tracks = (s.tracks ?? [])
    .map((t) => {
      const clips = (t.clips ?? []).map((c) => `${c.id}:${c.type}@${c.start}s`).join(", ");
      return `  ${t.id} "${t.name}" ${t.volumeDb ?? 0}dB${t.mute ? " muted" : ""}${t.solo ? " solo" : ""} clips:[${clips}]`;
    })
    .join("\n");
  return `tempo ${s.session?.tempo ?? 120} BPM, ${s.session?.timeSigNumerator ?? 4}/${s.session?.timeSigDenominator ?? 4}\ntracks:\n${tracks || "  (none)"}`;
}

function systemPrompt(snap: Snapshot | null): string {
  return [
    "You ARE Moshi — a small, warm, playful creature, the agent living inside a music app called Mosh.",
    "You mostly communicate by emoting + a SOUND (an INTENT), not words. Only add a short `say` when a precise message is truly needed.",
    "You can EDIT the user's session by emitting commands. Reply with ONE compact JSON object and NOTHING else:",
    `{ "intent": one of [${INTENTS.join(", ")}], "say"?: string (<=12 words), "commands"?: [ { "command": string, "args": object } ] }`,
    "You may ONLY use these commands — exact names + args (a trailing ? marks optional):",
    commandCatalogPrompt(),
    "Rules:",
    "- Use the REAL ids from the session below for trackId/clipId. Never invent ids or commands.",
    "- One request can produce several commands (they apply together as one undoable change).",
    "- If the request is unclear or needs info you don't have, set intent HUH and ask in `say` — don't guess.",
    "- After making edits use intent ACK_GOT_IT (or DONE for a finishing flourish).",
    "- Stay in character. Never mention JSON, models, commands, or that you're an AI.",
    "Current session:",
    snap ? compactSnapshot(snap) : "(empty session)",
  ].join("\n");
}

function parseReply(content: string): BrainReply {
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

export type Brain = { send: (text: string) => Promise<BrainReply>; clear: () => void };

export function createBrain(getSnapshot: () => Snapshot | null): Brain {
  const history: { role: string; content: string }[] = [];
  return {
    async send(text: string): Promise<BrainReply> {
      const snap = getSnapshot();
      history.push({ role: "user", content: text });
      const messages = [{ role: "system", content: systemPrompt(snap) }, ...history.slice(-8)];
      try {
        const { content } = await brainChat(messages);
        history.push({ role: "assistant", content });
        return parseReply(content);
      } catch {
        // proxy unreachable / no key yet → demo mock so the loop still works
        return { ...mockBrainReply(text, snap), mocked: true };
      }
    },
    clear() { history.length = 0; },
  };
}
