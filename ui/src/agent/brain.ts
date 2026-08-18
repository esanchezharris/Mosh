// M2 (Phase-B memory lane, flag `agentMemory`, default ON): before building the
// system prompt, hydrate the agent-memory pools (memoized after the first turn — see
// memory/hydrate.ts) and fold the few relevant preferences/patterns/project-notes
// into the prompt via memory/retrieveContext.ts. A fresh install with nothing ever
// written to agent memory hydrates to empty pools, so `memory` stays unpassed and
// the prompt is byte-identical to the pre-M2 shape (systemPrompt's own contract).
//
// M3: the memory section ALSO carries the remember_preference pseudo-command's
// serve-time doc (memory/rememberPreference.ts) whenever the flag is on —
// REGARDLESS of whether any pool has content yet. Gating the doc on non-empty
// pools would make the tool undiscoverable on a fresh install (nothing to retrieve
// ⇒ never told the tool exists ⇒ never able to write the FIRST memory). So `memory`
// is now non-empty for every flag-on session, not just ones with existing content —
// an intentional M3 change from M2's "only when pools are non-empty" gate.

import { brainChat, demoBrainAvailable } from "../bridge";
import { mockBrainReply } from "./brainMock";
import { systemPrompt, parseReply, type BrainReply } from "./brainCore";
import { useSettings } from "../settings/store";
import { ensureMemoryHydrated, poolsNonEmpty } from "./memory/hydrate";
import { retrieveContext } from "./memory/retrieveContext";
import { rememberPreferenceToolDoc } from "./memory/rememberPreference";
import type { Snapshot } from "../types";

// Re-export the reply type so importers keep a single brain entry point (the pure
// INTENTS/systemPrompt/parseReply are imported straight from brainCore by consumers).
export type { BrainReply } from "./brainCore";

export type Brain = { send: (text: string) => Promise<BrainReply>; clear: () => void };

const memoryOn = (): boolean => useSettings.getState().get("agentMemory") !== false;

/** The M2/M3 memory section for one turn's query: the remember_preference tool doc
 *  (always, when the flag is on) plus whatever's relevant from the pools (M2 —
 *  omitted when nothing overlaps the query). "" only when the flag itself is off.
 *  Hydration is memoized (memory/hydrate.ts) so only the FIRST call in a session
 *  pays the fetch. Never throws — a hydration failure degrades to no retrieved
 *  content (readMemory in hydrate.ts already fails soft per-pool); the tool doc is
 *  pure/synchronous and always succeeds. */
async function memorySectionFor(query: string): Promise<string> {
  if (!memoryOn()) return "";
  const pools = await ensureMemoryHydrated();
  const retrieved = poolsNonEmpty(pools) ? retrieveContext(query, pools) : "";
  return [retrieved, rememberPreferenceToolDoc()].filter(Boolean).join("\n\n");
}

export function createBrain(getSnapshot: () => Snapshot | null): Brain {
  const history: { role: string; content: string }[] = [];
  return {
    async send(text: string): Promise<BrainReply> {
      const snap = getSnapshot();
      history.push({ role: "user", content: text });
      // Pass the turn text so systemPrompt injects the few relevant producer-knowledge
      // cards next to the command catalog (WHY/WHEN for the controls this request touches).
      const memory = await memorySectionFor(text);
      const messages = [{ role: "system", content: systemPrompt(snap, text, memory) }, ...history.slice(-8)];
      try {
        const { content } = await brainChat(messages);
        const reply = parseReply(content);

        history.push({ role: "assistant", content });
        return reply;
      } catch {
        if (demoBrainAvailable()) return mockBrainReply(text, snap);
        return { intent: "UHOH", say: "can't reach my brain — check setup and try again" };
      }
    },
    clear() { history.length = 0; },
  };
}
