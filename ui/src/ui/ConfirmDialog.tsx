import type { ReactNode } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

// Generic yes/no confirmation modal — matches the existing .modal-backdrop/.modal
// chrome (PluginBrowser et al.) so a confirmation reads like every other overlay in
// the app. Escape and a backdrop click both cancel (the safe default for a prompt
// that's gating a destructive/irreversible action).
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
  testId,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  useEscapeToClose(true, onCancel);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head"><strong className="display">{title}</strong></div>
        <div className="confirm-body pop-note">{body}</div>
        <div className="pop-actions confirm-actions">
          <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            onClick={onConfirm}
            autoFocus
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
