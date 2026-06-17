// Moshi's brain — turns a chat turn into a behaviour + (optionally) a list of real
// edits. It feeds the LLM a persona, the curated command catalog, and a compact
// snapshot, and asks for ONE JSON object: { intent, say?, commands? }. If the proxy
// is unreachable (no keys yet), it falls back to a tiny demo mock so the loop still
// works in the preview. Ported/extended from design-lab/playground/brain.js.

import { brainChat } from "../bridge";
import { mockBrainReply } from "./brainMock";
import { parseReply, type BrainReply } from "./parseReply";
import { systemPrompt } from "./prompt";
import { retrieveCards } from "./knowledge/retrieve";
import type { Snapshot } from "../types";

export type { BrainReply } from "./parseReply";

export type Brain = { send: (text: string) => Promise<BrainReply>; clear: () => void };

export function createBrain(
  getSnapshot: () => Snapshot | null,
  getPluginNames?: () => string[],
): Brain {
  const history: { role: string; content: string }[] = [];
  return {
    async send(text: string): Promise<BrainReply> {
      const snap = getSnapshot();
      history.push({ role: "user", content: text });
      // Pull in the single most relevant validated card for THIS request. Top-1, not
      // top-3: the efficacy A/B showed top-3 floods (and degrades) weaker models, while
      // top-1 is the proven no-harm floor. retrieve.ts keeps its k=3 default for other callers.
      const cards = retrieveCards(text, 1);
      const messages = [{ role: "system", content: systemPrompt(snap, getPluginNames?.() ?? [], cards) }, ...history.slice(-8)];
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
