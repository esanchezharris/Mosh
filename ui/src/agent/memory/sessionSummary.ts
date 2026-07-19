// M3 (Phase-B memory lane, item 5) — session summaries on project switch. A
// deterministic digest of "what happened this session", written as a PROJECT-scope
// note so the next time this song is opened, Moshi's memory carries a short recap
// instead of starting cold every session.
//
// Pure/deterministic core (buildSessionDigest) + one OPTIONAL brain_chat polish layer
// (polishSessionSummary) that smooths the bullet digest into a couple of readable
// sentences when a brain provider is reachable, and falls back to the raw digest on
// ANY failure (unreachable, no key, timeout) — the digest itself is always a complete,
// useful summary on its own; the polish is a nice-to-have, never a dependency.

import { describeCommand } from "../commands";
import type { SessionLogEntry } from "./sessionLog";

// Commands that don't represent a producer decision worth recapping — reads, transport
// scrubbing, undo/redo, save/reload, the memory system's own bookkeeping (a summary
// listing "wrote a memory note" would be circular/uninteresting), and one-time app-
// lifecycle setup that fires automatically and carries zero producer intent.
//
// enable_all_meters is the concrete reason this list exists at all, not a guess: store.ts's
// init() fires it unconditionally ("Once at init only" — see its own comment) to start the
// live level-meter telemetry, on EVERY page load. Left unfiltered, `describeCommand`'s
// generic fallback turns it into "enable all meters" — a real, non-empty digest line for a
// command NO producer ever chose to run — which was firing writeSessionSummary's optional
// chat-polish call on the very FIRST project switch of a session (even one with a completely
// idle producer), a genuinely surprising real LLM call as a side effect of "New Project".
// Caught by a collateral e2e failure: hands-free.spec.ts's "unknown speech ... never the
// brain" asserts zero /api/brain/chat calls across a whole test, and its setup happens to
// call newProject() — an unrelated feature's stray brain call tripped an unrelated safety
// assertion. Fixed at the source (filtered here) rather than in the test.
const NOISY_EXACT = new Set([
  "batch_begin", "batch_end", "undo", "redo", "save", "save_as", "reload",
  "set_transport", "agent_memory_write", "agent_memory_read",
  "agent_memory_delete", "agent_memory_clear", "remember_preference",
  "enable_all_meters",
]);
function isNoisy(command: string): boolean {
  return NOISY_EXACT.has(command) || command.startsWith("get_") || command.startsWith("list_");
}

/** Deterministic ~maxLines-line digest: the most-repeated meaningful actions this
 *  session, each described via the SAME describeCommand() the change-toast/step-chip UI
 *  already uses (so the vocabulary in a recalled memory matches what the producer saw
 *  live). Ties broken by first-occurrence order. Empty log/all-noisy -> "". */
export function buildSessionDigest(log: readonly SessionLogEntry[], maxLines = 4): string {
  const counts = new Map<string, number>();
  const firstIndex = new Map<string, number>();
  log.forEach((e, i) => {
    if (!e.ok || isNoisy(e.command)) return;
    const label = describeCommand(e.command, e.args);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (!firstIndex.has(label)) firstIndex.set(label, i);
  });
  const lines = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (firstIndex.get(a[0])! - firstIndex.get(b[0])!))
    .slice(0, maxLines)
    .map(([label, n]) => (n > 1 ? `- ${label} (×${n})` : `- ${label}`));
  return lines.join("\n");
}

export type ChatFn = (messages: { role: string; content: string }[]) => Promise<{ content: string }>;

/** Optional polish: asks the brain to turn the bullet digest into a short, plain-
 *  language recap (still terse — a couple of sentences), for a nicer note to re-read
 *  next session. Any failure (unreachable, error, empty reply) falls back to the raw
 *  digest verbatim — this must never block or fail the project switch it's attached to. */
export async function polishSessionSummary(digest: string, chat: ChatFn): Promise<string> {
  if (!digest) return digest;
  try {
    const res = await chat([
      { role: "system", content: "Rewrite this bullet list of session activity as 2-3 short plain sentences, in past tense, no preamble, no markdown. Keep it factual — don't invent details beyond what's listed." },
      { role: "user", content: digest },
    ]);
    const text = res.content?.trim();
    return text ? text : digest;
  } catch {
    return digest;
  }
}
