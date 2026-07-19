// Moshi's brain — turns a chat turn into a behaviour + (optionally) a list of real
// edits. It feeds the LLM a persona, the curated command catalog, and a compact
// snapshot, and asks for ONE JSON object: { intent, say?, commands? }. If the proxy
// is unreachable (no keys yet), it falls back to a tiny demo mock so the loop still
// works in the preview. The pure prompt + parse logic lives in brainCore.ts (so the
// offline benchmark can score the exact prompt without pulling the bridge/window).
//
// WP-11 best-of-n (flag `bestOfNServing`, default OFF): after the single-shot reply
// parses, taste-classified command batches escalate through the native relay (the
// service draws + ranks more candidates; any failure keeps the single-shot reply),
// and corrective batches get ONE validator-retry re-prompt carrying the exact
// validation failure. Living HERE means both shells + the voice path inherit it.
//
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

import { archivePair, brainChat, escalateCandidates } from "../bridge";
import { mockBrainReply } from "./brainMock";
import { systemPrompt, parseReply, type BrainReply } from "./brainCore";
import { maybeEscalate, maybeValidatorRetry } from "./bestOfN";
import { useSettings } from "../settings/store";
import { ensureMemoryHydrated, poolsNonEmpty } from "./memory/hydrate";
import { retrieveContext } from "./memory/retrieveContext";
import { rememberPreferenceToolDoc } from "./memory/rememberPreference";
import type { Snapshot } from "../types";

// Re-export the reply type so importers keep a single brain entry point (the pure
// INTENTS/systemPrompt/parseReply are imported straight from brainCore by consumers).
export type { BrainReply } from "./brainCore";

export type Brain = { send: (text: string) => Promise<BrainReply>; clear: () => void };

const bestOfNOn = (): boolean => useSettings.getState().get("bestOfNServing") === true;
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

        // Best-of-n augmentation (flag-gated). It must NEVER discard the valid
        // single-shot reply: its own inner failures return null, and this guard
        // catches anything that escapes (e.g. manifest/catalog build) so a
        // best-of-n error can't fall through to the demo mock below.
        let chosen = reply;
        let replaced = false;
        try {
          const esc = await maybeEscalate(text, reply, snap, messages, {
            enabled: bestOfNOn, escalate: escalateCandidates,
          });
          if (esc) { chosen = esc.reply; replaced = true; }
          else {
            // Validator-retry (corrective ops) — one re-prompt with the exact failure.
            const retried = await maybeValidatorRetry(text, reply, messages, {
              enabled: bestOfNOn, chat: brainChat, parse: parseReply, archive: archivePair,
            });
            if (retried) { chosen = retried; replaced = true; }
          }
        } catch { /* keep the single-shot reply — never degrade to the mock */ }

        // History: the raw content normally; when best-of-n REPLACED the reply,
        // record what actually executed so turn N+1's "that" / "same again"
        // refers to the real edits, not the discarded single-shot draft.
        history.push({
          role: "assistant",
          content: replaced
            ? JSON.stringify({ intent: chosen.intent, say: chosen.say, commands: chosen.commands })
            : content,
        });
        return chosen;
      } catch {
        // proxy unreachable / no key yet → demo mock so the loop still works
        return mockBrainReply(text, snap);
      }
    },
    clear() { history.length = 0; },
  };
}
