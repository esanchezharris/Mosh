import { useStore } from "../store";
import type { Snapshot } from "../types";

/** Pure visibility rule (testable without a DOM): show only when the backend flagged an
 *  unclean prior exit AND the user hasn't dismissed it this session. */
export function shouldShowRecoveryNotice(snapshot: Snapshot | null, dismissed: boolean): boolean {
  return Boolean(snapshot?.session.recoveryAvailable) && !dismissed;
}

/** A2 — a one-time, dismissable crash-recovery notice. Shown when the backend reports the
 *  prior session ended uncleanly (`session.recoveryAvailable`). Autosave already restored the
 *  last good save, so Phase 1 is informational; Phase 2 (JSONL replay) will offer a real
 *  Recover/Discard. Dismissal is UI-local (view state, not a command). */
export function RecoveryNotice() {
  const snapshot = useStore((s) => s.snapshot);
  const dismissed = useStore((s) => s.recoveryDismissed);
  const dismiss = useStore((s) => s.dismissRecovery);
  if (!shouldShowRecoveryNotice(snapshot, dismissed)) return null;
  return (
    <div className="error-bar" role="status" aria-live="polite" data-testid="recovery-notice">
      ↩ Your last session ended unexpectedly — restored from the last auto-save.
      <button type="button" onClick={dismiss} style={{ marginLeft: 8 }}>Dismiss</button>
    </div>
  );
}
