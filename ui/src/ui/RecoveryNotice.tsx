import { useStore } from "../store";
import type { Snapshot } from "../types";

/** Pure visibility rule (testable without a DOM): show when the backend flagged an unclean
 *  prior exit, OR when a third-party plugin is implicated in a crash — and the user hasn't
 *  dismissed it this session.
 *
 *  FS-T2: the plugin conditions are deliberately NOT gated on recoveryAvailable. A plugin
 *  that crashes while the project is LOADING dies before the `session.running` sentinel is
 *  written, so recoveryAvailable is false in exactly the case the producer most needs an
 *  explanation for — their plugins are missing and the project is read-only. */
export function shouldShowRecoveryNotice(snapshot: Snapshot | null, dismissed: boolean): boolean {
  if (dismissed) return false;
  const s = snapshot?.session;
  return Boolean(s?.recoveryAvailable) || Boolean(s?.safeModeActive) || (s?.pluginCrashSuspects?.length ?? 0) > 0;
}

/** FS-T2 — what the notice should say/offer about third-party plugins.
 *  `quarantineTarget` is read from the backend, never re-derived here: it is empty unless
 *  there is exactly ONE suspect, because blocklisting is permanent and guessing across
 *  candidates would quarantine plugins the producer paid for. */
export function safeModeOffer(snapshot: Snapshot | null): {
  active: boolean;
  canOffer: boolean;
  suspects: string[];
  quarantineTarget: string;
} {
  const s = snapshot?.session;
  const suspects = s?.pluginCrashSuspects ?? [];
  const active = Boolean(s?.safeModeActive);
  return {
    active,
    canOffer: !active && suspects.length > 0,
    suspects,
    quarantineTarget: s?.pluginQuarantineTarget ?? "",
  };
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
  const safe = safeModeOffer(snapshot);
  const unclean = Boolean(snapshot?.session.recoveryAvailable);

  const onRecover = async () => {
    await exec("recover_session", {});
    await refresh();
    dismiss();
  };
  const onDismiss = async () => {
    await exec("discard_recovery", {});
    dismiss();
  };
  const onSafeMode = async () => {
    await exec("open_without_plugins", {});
    await refresh();
  };
  const onReopenNormally = async () => {
    await exec("reload", {});
    await refresh();
    dismiss();
  };

  return (
    <div className="error-bar" role="status" aria-live="polite" data-testid="recovery-notice">
      {safe.active ? (
        <>
          ⚠ Opened <strong>without your third-party plugins</strong> — the last launch crashed while
          loading {safe.suspects.length > 0 ? safe.suspects.join(", ") : "them"}. This project is
          read-only until you reopen it normally, so nothing gets overwritten.
          <button type="button" onClick={onReopenNormally} style={{ marginLeft: 8 }} data-testid="recovery-reopen-normally">
            Reopen with plugins
          </button>
        </>
      ) : (
        <>
          {unclean
            ? "↩ Your last session ended unexpectedly — restored from the last auto-save."
            : "⚠ The last launch crashed while loading a plugin."}
          {count > 0 && (
            <>
              {" "}<strong>{count}</strong> unsaved change{count === 1 ? "" : "s"} can be recovered.
              <button type="button" onClick={onRecover} style={{ marginLeft: 8 }} data-testid="recovery-recover">Recover</button>
            </>
          )}
          {safe.canOffer && (
            <>
              {" "}Suspect{safe.suspects.length === 1 ? "" : "s"}: <strong>{safe.suspects.join(", ")}</strong>.
              <button type="button" onClick={onSafeMode} style={{ marginLeft: 8 }} data-testid="recovery-safe-mode">
                Open without third-party plugins
              </button>
            </>
          )}
        </>
      )}
      <button type="button" onClick={onDismiss} style={{ marginLeft: 8 }}>Dismiss</button>
    </div>
  );
}
