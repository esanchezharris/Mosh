// Moshi's brain — turns a chat turn into a behaviour + (optionally) a list of real
// edits. It feeds the LLM a persona, the curated command catalog, and a compact
// snapshot, and asks for ONE JSON object: { intent, say?, commands? }. If the proxy
// is unreachable (no keys yet), it falls back to a tiny demo mock so the loop still
// works in the preview. The pure prompt + parse logic lives in brainCore.ts (so the
// offline benchmark can score the exact prompt without pulling the bridge/window).

import { brainChat } from "../bridge";
import { mockBrainReply } from "./brainMock";
import { systemPrompt, parseReply, type BrainReply } from "./brainCore";
import type { Snapshot } from "../types";

// Re-export the reply type so importers keep a single brain entry point (the pure
// INTENTS/systemPrompt/parseReply are imported straight from brainCore by consumers).
export type { BrainReply } from "./brainCore";

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
        return mockBrainReply(text, snap);
      }
    },
    clear() { history.length = 0; },
  };
}
