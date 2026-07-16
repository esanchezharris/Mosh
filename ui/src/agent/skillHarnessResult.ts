import type { AgentCommandCall, ChangeSet } from "./executor";

export type ChangeSetCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly reportedApplied: number };

export function checkSkillChangeSet(
  skill: string,
  calls: readonly AgentCommandCall[],
  changes: ChangeSet,
): ChangeSetCheck {
  const successfulEntries = changes.entries.filter((entry) => entry.ok).length;
  const reportedApplied = Math.max(0, changes.applied, successfulEntries);
  if (!Number.isInteger(changes.applied) || changes.applied < 0 || changes.applied > calls.length)
    return {
      ok: false,
      reason: `${skill}: batch reported invalid applied count ${changes.applied}`,
      reportedApplied,
    };
  if (changes.entries.length !== calls.length)
    return {
      ok: false,
      reason: `${skill}: batch returned ${changes.entries.length}/${calls.length} command results`,
      reportedApplied,
    };

  const seen = new Set<number>();
  for (const entry of changes.entries) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= calls.length)
      return {
        ok: false,
        reason: `${skill}: batch returned invalid command index ${entry.index}`,
        reportedApplied,
      };
    if (seen.has(entry.index))
      return {
        ok: false,
        reason: `${skill}: batch returned duplicate command index ${entry.index}`,
        reportedApplied,
      };
    seen.add(entry.index);
    const call = calls[entry.index];
    if (!call || entry.command !== call.command)
      return {
        ok: false,
        reason: `${skill}: batch result ${entry.index} does not match its command`,
        reportedApplied,
      };
  }

  if (successfulEntries !== changes.applied)
    return {
      ok: false,
      reason: `${skill}: applied count disagrees with command results`,
      reportedApplied,
    };
  const failed = changes.entries.find((entry) => !entry.ok);
  if (failed)
    return {
      ok: false,
      reason: failed.error ?? `${skill}: command ${failed.command} failed`,
      reportedApplied,
    };
  if (changes.applied !== calls.length)
    return {
      ok: false,
      reason: `${skill}: only ${changes.applied}/${calls.length} commands applied`,
      reportedApplied,
    };
  return { ok: true };
}
