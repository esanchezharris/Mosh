import { useState, type ReactNode } from "react";
import { useStore } from "../store";
import { MultiplayerPanel } from "../ui/MultiplayerPanel";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

// The v2 shell's prominent multiplayer entry point. Both the top-bar "Invite" pill
// and the Collaborators-card "Invite collaborator" button render this instead of
// calling mpCreateSession() directly.
//
// The bug this replaces: a one-click Invite button that only ever CREATED a new
// session, with no Join-with-code entry anywhere in the default shell (Join lived
// only in the "More tools" overflow's MultiplayerTool). A guest who wanted to join
// clicked the only affordance they could find ("Invite") and created a second,
// disconnected session instead of joining the host's — and the host's room code was
// never shown anywhere they'd think to look.
//
// This opens a centered modal (not a small anchored popover) so it reads regardless
// of whether it's triggered from the narrow right rail or the top bar, and so there's
// always room for BOTH the Create button and the Join-with-code field side by side
// with the room code. MultiplayerPanel (shared with the classic shell) renders the
// roster + a re-copyable room code once a session is active, so re-opening this from
// the host's side re-surfaces the code to re-share it.
export function MultiplayerLauncher({
  className,
  label,
  ariaLabel,
  testId,
}: {
  className?: string;
  label: ReactNode;
  ariaLabel?: string;
  testId?: string;
}) {
  const active = useStore((s) => s.mp.active);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEscapeToClose(open, close);

  return (
    <>
      <button
        type="button"
        className={className}
        data-testid={testId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={close} data-testid="mp-launcher-backdrop">
          <div
            className="modal mp-launcher-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Multiplayer session"
            data-testid="mp-launcher-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <strong className="display">{active ? "Session" : "Start a session"}</strong>
              <button type="button" className="btn x" aria-label="Close" onClick={close}>✕</button>
            </div>
            <div className="mp-launcher-body">
              <MultiplayerPanel />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
