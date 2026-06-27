import { useStore } from "../store";
import type { Snapshot } from "../types";

/** Pure visibility rule (testable without a DOM): show only when the backend flagged an
 *  unclean prior exit AND the user hasn't dismissed it this session. */
export function shouldShowRecoveryNotice(snapshot: Snapshot | null, dismissed: boolean): boolean {
  return Boolean(snapshot?.session.recoveryAvailable) && !dismissed;
}

/** A2/A3 — a one-time crash-recovery notice. The prior session ended unexpectedly; autosave
 *  already restored the last good save. When the A3 journal has replayable unsaved work
 *  (recoverableCount > 0) we offer "Recover" (recover_session replays the tail); otherwise the
 *  notice is informational. Either way "Dismiss" clears it (discard_recovery drops the tail).
 *  Dismissal is UI-local view state; the commands cross the bridge. */
export function RecoveryNotice() {
  const snapshot = useStore((s) => s.snapshot);
  const dismissed = useStore((s) => s.recoveryDismissed);
  const dismiss = useStore((s) => s.dismissRecovery);
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  if (!shouldShowRecoveryNotice(snapshot, dismissed)) return null;

  const count = snapshot?.session.recoverableCount ?? 0;

  const onRecover = async () => {
    await exec("recover_session", {});
    await refresh();
    dismiss();
  };
  const onDismiss = async () => {
    await exec("discard_recovery", {});
    dismiss();
  };

  return (
    <div className="error-bar" role="status" aria-live="polite" data-testid="recovery-notice">
      ↩ Your last session ended unexpectedly — restored from the last auto-save.
      {count > 0 && (
        <>
          {" "}<strong>{count}</strong> unsaved change{count === 1 ? "" : "s"} can be recovered.
          <button type="button" onClick={onRecover} style={{ marginLeft: 8 }} data-testid="recovery-recover">Recover</button>
        </>
      )}
      <button type="button" onClick={onDismiss} style={{ marginLeft: 8 }}>Dismiss</button>
    </div>
  );
}
