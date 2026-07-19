// M3 (Phase-B memory lane) — the agent-INITIATED write path. remember_preference is
// a PSEUDO-command: it is DELIBERATELY never added to AGENT_COMMANDS (the static
// catalog commandCatalogPrompt() renders — see commands.contract.test.ts's
// MEMORY_COMMANDS ∩ AGENT_COMMAND_MAP === ∅ assertion), so the SHIPPED single-shot
// prompt (SFT/GEPA/bench, brainCore.ts's byte-stability contract) never moves as a
// side effect of this feature.
//
// Instead it is "serve-time-documented": rememberPreferenceToolDoc() below is folded
// into the flag-gated `memory` prompt section (brain.ts / loop/runTask.ts), a
// SEPARATE, dynamic seam from the static catalog. The executor (executor.ts /
// loop/taskExec.ts) intercepts any call to it BEFORE validateCommand ever sees the
// name — validateCommand would otherwise reject it as "not an allowed command",
// since it has no ArgSpec and never will.
//
// Writes explicit:false — the model is GUESSING at what's worth remembering, not the
// producer directly asking (that's the fastPath "remember" rule, explicit:true;
// see writePreference.ts, shared by both).

import { writePreference, type ExecFn } from "./writePreference";

/** Every pseudo-command name the executor intercepts before validateCommand. A
 *  single-entry set today; a stable, growable seam for a future addition. */
export const MEMORY_COMMANDS: ReadonlySet<string> = new Set(["remember_preference"]);

export type MemoryCommandResult = { command: string; ok: boolean; error?: string };

/** Handles ONE intercepted remember_preference call. Returns a {command,ok,error}
 *  triple in the same shape callers already push into their entries/results arrays
 *  (ChangeEntry in executor.ts, StepCommandResult in loop/taskExec.ts) — so the
 *  EXISTING confirm surfaces (ChangeToast's summary line; the loop drawer's
 *  StepChip, once describeCommand knows this command name) render it with zero new
 *  UI, the same way any other command result already does. */
export async function handleRememberPreference(
  args: Record<string, unknown> | undefined,
  exec: ExecFn,
): Promise<MemoryCommandResult> {
  const text = typeof args?.text === "string" ? args.text : "";
  if (!text.trim())
    return { command: "remember_preference", ok: false, error: "remember_preference: missing 'text'" };

  const res = await writePreference(exec, text, "global", false);
  return res.ok
    ? { command: "remember_preference", ok: true }
    : { command: "remember_preference", ok: false, error: res.error };
}

/** The serve-time doc block: how to call remember_preference, and when to bother.
 *  Deliberately terse (this rides the SAME per-turn byte budget as everything else
 *  in the prompt) and deliberately NOT part of commandCatalogPrompt() — see the file
 *  header. Folded into the `memory` section (brainCore.ts's 5th param /
 *  loopPrompt.ts's 3rd param) whenever the `agentMemory` flag is on, REGARDLESS of
 *  whether any pool has content yet (a fresh install with nothing remembered yet is
 *  exactly when the model most needs to know this tool exists — gating it on
 *  non-empty pools would make it undiscoverable until something else populated
 *  memory first, a chicken-and-egg dead end). */
export function rememberPreferenceToolDoc(): string {
  return [
    "You can also call remember_preference to save something worth recalling in future turns —",
    'reply with a command exactly like {"command":"remember_preference","args":{"text":string}}.',
    'Use it sparingly: only for a genuinely durable producer preference ("always wants heavy 808s"), never for a one-off request.',
  ].join(" ");
}
