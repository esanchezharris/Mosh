import { useState } from "react";
import { useStore } from "../store";
import { archivePair } from "../bridge";
import { buildFeltWrongRow } from "../agent/feltWrong";
import { getSessionLog } from "../agent/memory/sessionLog";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

// Taste loop (workshop 2026-07-19): the ⌘⇧F "felt wrong" capture. A two-word tag +
// the command-diff since the last felt-right waterline + a snapshot, archived through
// the existing best-effort DPO appender under source "felt-wrong" (a NEW lane —
// never folded into single-shot SFT surfaces). Archival is best-effort by contract:
// it must never block or break the session, so failures are swallowed like the
// agent-loop lane's archivePair call.
export function FeltWrongDialog() {
  const open = useStore((s) => s.feltWrongOpen);
  const close = useStore((s) => s.setFeltWrongOpen);
  const [tag, setTag] = useState("");
  useEscapeToClose(open, () => close(false));
  if (!open) return null;

  const submit = () => {
    const clean = tag.trim();
    if (!clean) return;
    const snap = useStore.getState().snapshot;
    try {
      const row = buildFeltWrongRow(clean, getSessionLog(), snap);
      void archivePair(row).catch(() => { /* best-effort by contract */ });
    } catch { /* empty tag already guarded; never break the session */ }
    setTag("");
    close(false);
  };

  return (
    <div className="modal-backdrop" onClick={() => close(false)}>
      <div
        className="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Felt wrong"
        data-testid="felt-wrong-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head"><strong className="display">Felt wrong</strong></div>
        <div className="confirm-body pop-note">
          Two words for what felt off — this moment becomes a bench task.
        </div>
        <input
          className="felt-wrong-input"
          autoFocus
          value={tag}
          placeholder="e.g. drums stiff"
          maxLength={48}
          data-testid="felt-wrong-tag"
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            e.stopPropagation(); // typing must never trigger app shortcuts
          }}
        />
        <div className="pop-actions confirm-actions">
          <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!tag.trim()}
            onClick={submit}
            data-testid="felt-wrong-save"
          >
            Capture
          </button>
        </div>
      </div>
    </div>
  );
}
