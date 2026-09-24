import { useState } from "react";
import { useStore } from "../store";
import type { RecordingResidueEntry, Snapshot } from "../types";

/** Pure visibility rule (testable without a DOM): show when the backend flagged an unclean
 *  prior exit, OR when a third-party plugin is implicated in a crash, OR when a transaction
 *  from a previous run is still blocking the skill lane — and the user hasn't dismissed it
 *  this session.
 *
 *  FS-T2: the plugin conditions are deliberately NOT gated on recoveryAvailable. A plugin
 *  that crashes while the project is LOADING dies before the `session.running` sentinel is
 *  written, so recoveryAvailable is false in exactly the case the producer most needs an
 *  explanation for — their plugins are missing and the project is read-only.
 *
 *  Step-2 item A: `unresolvedTransactions` is likewise NOT gated on recoveryAvailable, and for
 *  the same reason turned inside out — that state needs no crash at all. A skill transaction
 *  that was merely interrupted leaves it, the `session.running` sentinel is long gone after one
 *  clean relaunch, and without this condition the only UI that can clear the block never
 *  renders. Dismiss runs `discard_recovery`, which is exactly the command that clears it. */
export function shouldShowRecoveryNotice(snapshot: Snapshot | null, dismissed: boolean): boolean {
  if (dismissed) return false;
  const s = snapshot?.session;
  return Boolean(s?.recoveryAvailable) || Boolean(s?.safeModeActive)
    || (s?.pluginCrashSuspects?.length ?? 0) > 0
    || (s?.unresolvedTransactions?.count ?? 0) > 0;
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
 *  Dismissal is UI-local view state; the commands cross the bridge.
 *
 *  `compact` (the V3 shell) keeps every action but not the volume: one calm line — "Restored
 *  from the last auto-save", the Recover action when there is unsaved work to replay, and
 *  Dismiss — with the crash's orphan takes behind a collapsed "N older recordings are still on
 *  disk" disclosure. After a real crash that list ran to 15 takes, each with two buttons, as a
 *  four-line red strip over the timeline. Expanding it shows the same per-take Recover take /
 *  Set aside, still one explicit decision per file; nothing is decided by opening it. */
export function RecoveryNotice({ compact = false }: { compact?: boolean }) {
  const [residueOpen, setResidueOpen] = useState(false);
  const snapshot = useStore((s) => s.snapshot);
  const dismissed = useStore((s) => s.recoveryDismissed);
  const dismiss = useStore((s) => s.dismissRecovery);
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  if (!shouldShowRecoveryNotice(snapshot, dismissed)) return null;

  const count = snapshot?.session.recoverableCount ?? 0;
  const safe = safeModeOffer(snapshot);
  const unclean = Boolean(snapshot?.session.recoveryAvailable);
  // Step-2 item A — how many transactions from a previous run are still refusing every skill.
  const blockedTxns = snapshot?.session.unresolvedTransactions?.count ?? 0;

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
  // CAP-001 — take WAVs the crash left on disk that no clip references. Adopt lands one
  // through the normal import at its recorded position; Quarantine renames it in place
  // (never deletes). Both are explicit per-file decisions; the list refreshes after each.
  const residue = snapshot?.session.recordingResidue ?? [];
  const onAdopt = async (file: string) => {
    const r = await exec("adopt_recording_residue", { file });
    if (!r.ok) useStore.setState({ lastError: r.error ?? "Could not recover the take." });
    await refresh();
  };
  const onQuarantine = async (file: string) => {
    const r = await exec("quarantine_recording_residue", { file });
    if (!r.ok) useStore.setState({ lastError: r.error ?? "Could not set the take aside." });
    await refresh();
  };

  const residueDetail = (r: RecordingResidueEntry) =>
    r.readable || r.repairable ? ` (${r.seconds.toFixed(1)} s, ${r.trackName || "no track"})` : " (unreadable)";
  const residueActions = (r: RecordingResidueEntry, className?: string) => (
    <>
      {r.decision === "adopt" && (
        <button type="button" className={className} onClick={() => void onAdopt(r.file)} style={{ marginLeft: 4 }}
          data-testid="recovery-residue-adopt">Recover take</button>
      )}
      <button type="button" className={className} onClick={() => void onQuarantine(r.file)} style={{ marginLeft: 4 }}
        data-testid="recovery-residue-quarantine">Set aside</button>
    </>
  );

  if (compact) {
    const warn = safe.active || !unclean;
    const lead = safe.active
      ? `⚠ Opened without your third-party plugins — the last launch crashed while loading ${
        safe.suspects.length > 0 ? safe.suspects.join(", ") : "them"}. Read-only until you reopen it normally.`
      : unclean
        ? "↩ Restored from the last auto-save"
        : blockedTxns > 0
          ? `⚠ ${blockedTxns} unfinished edit${blockedTxns === 1 ? "" : "s"} from a previous run ${
            blockedTxns === 1 ? "is" : "are"} blocking Moshi — your project is untouched; Dismiss clears ${
            blockedTxns === 1 ? "it" : "them"}.`
          : "⚠ The last launch crashed while loading a plugin.";
    return (
      <div className={`v3-recovery${warn ? " warn" : ""}`} role="status" aria-live="polite"
        data-testid="recovery-notice" data-compact="">
        <div className="v3-recovery-line">
          <span className="v3-recovery-lead">{lead}</span>
          {safe.active && (
            <button type="button" className="btn sm" onClick={onReopenNormally} data-testid="recovery-reopen-normally">
              Reopen with plugins
            </button>
          )}
          {!safe.active && count > 0 && (
            <>
              <span className="v3-recovery-sep" aria-hidden="true">·</span>
              <span>{count} unsaved change{count === 1 ? "" : "s"}</span>
              <button type="button" className="btn sm" onClick={onRecover} data-testid="recovery-recover">Recover</button>
            </>
          )}
          {!safe.active && residue.length > 0 && (
            <>
              <span className="v3-recovery-sep" aria-hidden="true">·</span>
              <button type="button" className="v3-recovery-disclosure" aria-expanded={residueOpen}
                aria-controls="v3-recovery-residue" data-testid="recovery-residue-toggle"
                onClick={() => setResidueOpen((open) => !open)}>
                {residue.length} older recording{residue.length === 1 ? " is" : "s are"} still on disk
              </button>
            </>
          )}
          {!safe.active && safe.canOffer && (
            <>
              <span className="v3-recovery-sep" aria-hidden="true">·</span>
              <span>Suspect{safe.suspects.length === 1 ? "" : "s"}: {safe.suspects.join(", ")}</span>
              <button type="button" className="btn sm" onClick={onSafeMode} data-testid="recovery-safe-mode">
                Open without third-party plugins
              </button>
            </>
          )}
          <span className="v3-recovery-fill" />
          <button type="button" className="btn sm ghost" onClick={onDismiss} data-testid="recovery-dismiss">Dismiss</button>
        </div>
        {!safe.active && residueOpen && residue.length > 0 && (
          <ul className="v3-recovery-residue" id="v3-recovery-residue" data-testid="recovery-residue">
            {residue.map((r) => (
              <li key={r.file} data-testid="recovery-residue-item">
                <span className="v3-recovery-take"><em>{r.name}</em>{residueDetail(r)}</span>
                {residueActions(r, "btn sm")}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

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
            : blockedTxns > 0
              ? // Say what is actually broken and what fixes it. The old copy claimed a plugin
                // crash, which is not what this state is — an edit from a previous run was
                // interrupted, and until it is cleared Moshi refuses every instruction.
                `⚠ ${blockedTxns} unfinished edit${blockedTxns === 1 ? "" : "s"} from a previous run ${
                  blockedTxns === 1 ? "is" : "are"
                } blocking Moshi — your project is untouched, but Moshi won't make changes until you dismiss this.`
              : "⚠ The last launch crashed while loading a plugin."}
          {count > 0 && (
            <>
              {" "}<strong>{count}</strong> unsaved change{count === 1 ? "" : "s"} can be recovered.
              <button type="button" onClick={onRecover} style={{ marginLeft: 8 }} data-testid="recovery-recover">Recover</button>
            </>
          )}
          {residue.length > 0 && (
            <span data-testid="recovery-residue">
              {" "}<strong>{residue.length}</strong> recording{residue.length === 1 ? "" : "s"} from that session
              {residue.length === 1 ? " was" : " were"} still on disk:
              {residue.map((r) => (
                <span key={r.file} style={{ marginLeft: 8 }} data-testid="recovery-residue-item">
                  <em>{r.name}</em>
                  {residueDetail(r)}
                  {residueActions(r)}
                </span>
              ))}
            </span>
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
      <button type="button" onClick={onDismiss} style={{ marginLeft: 8 }} data-testid="recovery-dismiss">Dismiss</button>
    </div>
  );
}
