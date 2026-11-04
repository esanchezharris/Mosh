import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useV3 } from "./shellState";
import { aiToolsSetupView, offerAiTools, useAiToolsInstaller, type AiToolsSetupView } from "./aiToolsSetup";

// "Add AI tools" (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.4). One card, met three ways:
// under "Go to the Booth" on the Start page, from the dock's "That needs AI tools" reply (the
// launcher below), and as the Settings row. The install runs in the background: nothing
// here ever blocks recording.

const STEP_MARK = { pending: "·", running: "…", done: "✓", failed: "✕", cancelled: "–" } as const;

function Steps({ view }: { view: AiToolsSetupView }) {
  return (
    <ul className="ai-steps" data-testid="v3-ai-tools-steps">
      {view.steps.map((s) => (
        <li key={s.id} className={s.status} data-step={s.id} data-status={s.status}>
          <span className="mark" aria-hidden="true">{STEP_MARK[s.status]}</span>{s.label}
        </li>
      ))}
    </ul>
  );
}

function Failure({ view }: { view: AiToolsSetupView }) {
  if (!view.error) return null;
  return (
    <div className="ai-fail" role="alert" data-testid="v3-ai-tools-error">
      <span>{view.error}</span>
      {view.detail && <pre className="ai-detail" data-testid="v3-ai-tools-detail">{view.detail}</pre>}
    </div>
  );
}

/** The setup card. `onClose` adds "Not now" (and "Done" once they're on). */
export function AiToolsCard({ onClose }: { onClose?: () => void }) {
  const ai = useStore((s) => s.snapshot?.aiTools);
  const { status, install, cancel } = useAiToolsInstaller();
  if (!status) return null;
  const view = aiToolsSetupView(ai, status);
  const busy = view.phase === "installing" || view.phase === "cancelling" || view.phase === "removing";
  return (
    <div className="ai-card" data-testid="v3-ai-tools-card" data-phase={view.phase}>
      {view.phase === "on" || view.phase === "external" ? (
        <p className="start-lead" role="status" data-testid="v3-ai-tools-done">
          AI tools are on. Beatbox → beat is in Files, and Moshi can transcribe your takes.
        </p>
      ) : view.phase === "unavailable" ? (
        <p className="set-hint">{view.status}</p>
      ) : (
        <>
          <p className="set-hint">
            Turns a beatbox into a beat, and lets Moshi transcribe your takes. Recording and mixing never need them.
          </p>
          <p className="set-hint" data-testid="v3-ai-tools-size">
            {view.size}. Mosh downloads Python and its packages from PyPI and GitHub. It runs in the background, so you can keep recording.
          </p>
          {(busy || view.phase === "failed" || view.phase === "partial") && <Steps view={view} />}
          {busy && <p className="set-hint" role="status" data-testid="v3-ai-tools-status">{view.status}</p>}
          <Failure view={view} />
        </>
      )}
      <div className="start-actions">
        {view.canInstall && (
          <button type="button" className="btn pri" data-testid="v3-ai-tools-install" onClick={() => void install()}>
            {view.phase === "failed" ? "Try again" : view.phase === "partial" ? "Finish installing" : "Install"}
          </button>
        )}
        {view.canCancel && (
          <button type="button" className="btn" data-testid="v3-ai-tools-cancel" onClick={() => void cancel()}>Cancel</button>
        )}
        {onClose && (
          <button type="button" className="btn ghost" data-testid="v3-ai-tools-close" onClick={onClose}>
            {view.phase === "on" || view.phase === "external" || busy ? "Close" : "Not now"}
          </button>
        )}
      </div>
    </div>
  );
}

/** The Start page's Ready step: a quiet line under "Go to the Booth", never a gate. Choosing
 *  it opens the card in place; a job already running shows the card straight away. */
export function AiToolsStartOffer() {
  const ai = useStore((s) => s.snapshot?.aiTools);
  const { status } = useAiToolsInstaller();
  const [open, setOpen] = useState(false);
  if (!status) return null;
  const view = aiToolsSetupView(ai, status);
  const running = view.phase === "installing" || view.phase === "cancelling";
  if (!open && !offerAiTools(view)) return null;
  return (
    <div className="start-ai" data-testid="v3-start-ai-tools">
      {open || running ? <AiToolsCard onClose={() => setOpen(false)} /> : (
        <div className="start-row">
          <span className="set-hint">Add AI tools (optional): beatbox into a beat, and more. {view.size}.</span>
          <button type="button" className="btn sm" data-testid="v3-start-ai-tools-open" onClick={() => setOpen(true)}>Add AI tools</button>
        </div>
      )}
    </div>
  );
}

/** Settings → AI tools: status, sizes, Install / Remove and the last error. */
export function AiToolsSettings() {
  const ai = useStore((s) => s.snapshot?.aiTools);
  const { status, install, cancel, remove } = useAiToolsInstaller();
  if (!status) return null;
  const view = aiToolsSetupView(ai, status);
  return (
    <div className="set-sec" data-testid="v3-ai-tools-settings" data-phase={view.phase}>
      <div className="set-label">AI tools</div>
      <p className="set-hint">Optional: Beatbox → beat and transcription. Recording and mixing never need them.</p>
      <div className="set-row"><span>Status</span><span className="val" data-testid="v3-ai-tools-state">{view.status}</span></div>
      {view.phase !== "unavailable" && view.phase !== "external" && (
        <div className="set-row"><span>Size</span><span className="val">{view.size}</span></div>
      )}
      <Failure view={view} />
      {(view.canInstall || view.canCancel || view.canRemove) && (
        <div className="ai-settings-actions">
          {view.canInstall && (
            <button type="button" className="btn sm pri" data-testid="v3-ai-tools-settings-install" onClick={() => void install()}>
              {view.phase === "failed" ? "Try again" : view.phase === "partial" ? "Finish installing" : "Install"}
            </button>
          )}
          {view.canCancel && (
            <button type="button" className="btn sm" data-testid="v3-ai-tools-settings-cancel" onClick={() => void cancel()}>Cancel</button>
          )}
          {view.canRemove && (
            <button type="button" className="btn sm" data-testid="v3-ai-tools-remove" onClick={() => void remove()}>Remove AI tools</button>
          )}
        </div>
      )}
    </div>
  );
}

/** The dock's reply button: opens the card. Hidden when this build can't add the tools. */
export function AiToolsOfferButton() {
  const ai = useStore((s) => s.snapshot?.aiTools);
  const { status } = useAiToolsInstaller();
  const open = useV3((s) => s.setAiToolsOpen);
  if (!status || aiToolsSetupView(ai, status).phase === "unavailable") return null;
  return (
    <button type="button" className="btn sm" data-testid="v3-ai-tools-offer" onClick={() => open(true)}>Add AI tools</button>
  );
}

/** The card as a dialog, for the dock's offer. */
export function AiToolsLauncher() {
  const open = useV3((s) => s.aiToolsOpen);
  const setOpen = useV3((s) => s.setAiToolsOpen);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useEscapeToClose(open, close);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="modal-root" data-testid="v3-ai-tools-root">
      <div className="scrim" onClick={close} />
      <div className="modal glass" role="dialog" aria-modal="true" aria-label="Add AI tools" data-testid="v3-ai-tools-modal">
        <div className="modal-hd">
          <b>Add AI tools (optional)</b>
          <button ref={closeRef} type="button" className="icon-x" aria-label="Close" onClick={close}>×</button>
        </div>
        <div className="modal-body">
          <AiToolsCard onClose={close} />
        </div>
      </div>
    </div>
  );
}
