// M3 (Phase-B memory lane, item 5) — a lightweight client-side ring buffer of the
// commands run against the CURRENTLY open project, feeding sessionSummary.ts's
// end-of-session digest.
//
// Why a client-side log at all: the native `get_command_log` inspector strips `args`
// from every entry (MoshOps.cpp's makeCommandLogInspectorEntry) — it exists for a
// human glancing at "what just ran", not for reconstructing "what did the user build
// this session" well enough to describe it (describeCommand needs the args). Rather
// than widen a native, on-disk-logged surface for a client-only summarization need,
// store.ts's exec() (the ONE funnel every mutation — UI, agent, loop — already goes
// through) mirrors each call here in memory, this-session-only, never persisted itself
// (the DIGEST it produces is what gets persisted, via agent_memory_write).
//
// Capped + FIFO so a very long session can't grow this unboundedly; the cap is far
// larger than sessionSummary's own maxLines so the digest always has real signal to
// rank, not just whatever survived truncation.

export type SessionLogEntry = {
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
};

const CAP = 300;
let buffer: SessionLogEntry[] = [];

export function recordSessionCommand(command: string, args: Record<string, unknown>, ok: boolean): void {
  buffer.push({ command, args, ok });
  if (buffer.length > CAP) buffer = buffer.slice(buffer.length - CAP);
}

/** A snapshot of everything recorded so far this session (oldest-first). */
export function getSessionLog(): readonly SessionLogEntry[] {
  return buffer;
}

/** Called once the outgoing project's digest has been written (or skipped) — a fresh
 *  project starts its own summary from a clean slate. */
export function clearSessionLog(): void {
  buffer = [];
}

/** Test-only: mirrors hydrate.ts's __resetMemoryHydrationForTests. */
export function __resetSessionLogForTests(): void {
  buffer = [];
}
