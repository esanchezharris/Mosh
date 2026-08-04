// REC-001 — Capture MIDI, in one place because it has TWO front doors: the transport
// button and ⇧⌘C. Duplicating the result handling across them is how one of them ends up
// silently swallowing the empty-handed case months later.
//
// The whole reason this is more than `exec("capture_midi")`: coming back with nothing is
// the COMMON outcome (you pressed it having played nothing into the buffer) and it is
// completely invisible — no clip appears either way. A caller that only checks `ok` shows
// nothing at all, and the button reads as broken.

export type CaptureOutcome = { captured: boolean; message: string | null };

type CaptureData = { applied?: boolean; reason?: string; clips?: unknown[] };

/** Only the three fields this actually reads, rather than the full CommandResult: the
 *  store's exec and runAction's ActionStore.exec disagree on whether `command` is
 *  optional, and neither disagreement is any of this function's business. */
type CaptureResult = { ok: boolean; error?: string; data?: unknown };

/** Runs capture_midi and reduces its three outcomes to "did we get clips" + what to tell
 *  the producer. Pure apart from the exec call, so both call sites — and the test — see
 *  identical behaviour. */
export async function runCaptureMidi(
  exec: (command: string, args?: Record<string, unknown>) => Promise<CaptureResult>,
): Promise<CaptureOutcome> {
  const r = await exec("capture_midi") as (CaptureResult & { data?: CaptureData }) | undefined;

  if (!r?.ok)
    return { captured: false, message: r?.error ?? "Could not capture." };

  if (!r.data?.applied)
    // The backend's own reason is passed through rather than reworded: it distinguishes
    // "no audio device" from "you played nothing", and those need different fixes.
    return { captured: false, message: `Nothing to capture — ${r.data?.reason ?? "nothing was played"}.` };

  return { captured: true, message: null };
}
