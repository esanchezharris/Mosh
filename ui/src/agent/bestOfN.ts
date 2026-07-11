// WP-11 best-of-n serving hook (spec: docs/superpowers/specs/
// 2026-07-04-bestofn-serving-skeleton.md). Lives INSIDE the brain turn so both
// shells + the voice path inherit it. Escalate-only contract: the single-shot
// reply is already in hand as candidate #0; ANY failure below (flag off, bridge
// missing, service down, degraded, timeout) returns null and the caller keeps
// that reply — a failure never costs an extra cloud call or a worse answer.
//
// Corrective ops get the other half of the policy: ONE validator-retry that
// re-prompts with the exact validation failure (the L2 lyric-loop pattern); the
// (failed, corrected) pair is fire-and-forgotten to the DPO archive.

import { archivePair, escalateCandidates } from "../bridge";
import { validateCommand } from "./commands";
import type { BrainReply } from "./brainCore";
import type { AgentCommandCall } from "./executor";
import { buildManifest, classifyCommands, serializeCatalog, type IdManifest } from "./policy";
import type { Snapshot } from "../types";

export type EscalateDeps = {
  enabled: () => boolean;
  escalate: typeof escalateCandidates;
  timeoutMs?: number;
};

export type EscalateResult = {
  reply: BrainReply;
  escalated: boolean;
  // surfaced for the falsifier/telemetry; undefined when not escalated
  firstIndex?: number;
  tieBreak?: boolean;
};

type Candidate = { say?: string | null; intent?: string | null; commands?: AgentCommandCall[]; score?: number };
type EscalateResponse = {
  ok?: boolean; degraded?: boolean; candidates?: Candidate[]; firstIndex?: number; tieBreak?: boolean;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/** Escalate a taste-classified reply. Returns null whenever the single-shot reply
 *  should stand (not taste, flag off, degraded, any error). */
export async function maybeEscalate(
  utterance: string,
  reply: BrainReply,
  snap: Snapshot | null,
  messages: { role: string; content: string }[],
  deps: EscalateDeps,
): Promise<EscalateResult | null> {
  const commands = reply.commands ?? [];
  if (!deps.enabled() || commands.length === 0) return null;
  if (classifyCommands(commands) !== "taste") return null;

  const payload = {
    utterance,
    messages,
    catalog: serializeCatalog(),
    manifest: buildManifest(snap),
    first: { say: reply.say ?? null, intent: reply.intent ?? null, commands },
    n: 4,
  };
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error("escalate timeout")), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    const r = (await Promise.race([deps.escalate(payload), timeout])) as EscalateResponse;
    const top = r?.candidates?.[0];
    if (!r?.ok || r.degraded || !top || !Array.isArray(top.commands) || top.commands.length === 0) return null;
    return {
      reply: { say: top.say ?? reply.say, intent: top.intent ?? reply.intent, commands: top.commands },
      escalated: true,
      firstIndex: r.firstIndex,
      tieBreak: r.tieBreak,
    };
  } catch {
    return null; // degrade silently — the single-shot reply stands
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** First validation failure in a command list (the retry prompt's payload). */
export function firstValidationError(commands: AgentCommandCall[]): string | null {
  for (const c of commands) {
    const err = validateCommand(c.command, c.args ?? {});
    if (err) return `${c.command}: ${err}`;
  }
  return null;
}

export type RetryDeps = {
  enabled: () => boolean;
  chat: (messages: { role: string; content: string }[]) => Promise<{ content: string }>;
  parse: (content: string) => BrainReply;
  archive: typeof archivePair;
};

/** ONE validator-retry for corrective replies: re-prompt with the exact failure;
 *  keep the corrected reply only if it now validates. The (failed, corrected)
 *  pair rides the DPO archive best-effort (program item 4: costs nothing extra). */
export async function maybeValidatorRetry(
  utterance: string,
  reply: BrainReply,
  messages: { role: string; content: string }[],
  deps: RetryDeps,
): Promise<BrainReply | null> {
  const commands = reply.commands ?? [];
  if (!deps.enabled() || commands.length === 0) return null;
  if (classifyCommands(commands) === "taste") return null;
  const failure = firstValidationError(commands);
  if (!failure) return null;

  try {
    const retryMessages = [
      ...messages,
      { role: "assistant", content: JSON.stringify({ intent: reply.intent, say: reply.say, commands }) },
      {
        role: "user",
        content:
          `Your command failed validation — ${failure}. Reply again with the SAME JSON shape, ` +
          `correcting only that. Do not add new commands.`,
      },
    ];
    const { content } = await deps.chat(retryMessages);
    const corrected = deps.parse(content);
    const stillBad = firstValidationError(corrected.commands ?? []);
    if (!corrected.commands?.length || stillBad) return null;

    // DPO fuel, best-effort — never let archiving affect the turn.
    void deps
      .archive({ source: "corrective-retry", utterance, failed: commands, corrected: corrected.commands, reason: failure })
      .catch(() => undefined);
    return corrected;
  } catch {
    return null; // retry is opportunistic — the original reply stands
  }
}

export type { IdManifest };
