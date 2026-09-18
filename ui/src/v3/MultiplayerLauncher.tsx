import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import { MultiplayerPanel } from "../ui/MultiplayerPanel";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useV3 } from "./shellState";

// V3's multiplayer entry point (V3 parity brief row 10). The v2 launcher's create / join /
// leave dialog (ui/src/v2/MultiplayerLauncher.tsx) rebuilt on V3's own modal chrome — the
// modal-root / scrim / modal glass pieces SettingsModal uses — around the SHARED
// MultiplayerPanel, unchanged. The trigger lives in TopBar ("Invite" / "Shared"); this renders
// only the dialog. `data-settings` remaps the panel's classic tokens (--ink / --bone) onto V3's,
// exactly as SettingsModal does for the shared settings rows. `mp-launcher-modal` is kept as
// the test id so the shared launcher assertions apply to both shells.
export function MultiplayerLauncher() {
  const open = useV3((s) => s.mpOpen);
  const setOpen = useV3((s) => s.setMpOpen);
  const active = useStore((s) => s.mp.active);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), [setOpen]);
  useEscapeToClose(open, close);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="modal-root" data-settings data-testid="v3-mp-root">
      <div className="scrim" onClick={close} data-testid="mp-launcher-backdrop" />
      <div className="modal glass" role="dialog" aria-modal="true" aria-label="Multiplayer session"
        data-testid="mp-launcher-modal">
        <div className="modal-hd">
          <b>{active ? "Session" : "Start a session"}</b>
          <button ref={closeRef} type="button" className="icon-x" aria-label="Close" onClick={close}>×</button>
        </div>
        <div className="modal-body mp-launcher-body">
          <MultiplayerPanel />
        </div>
      </div>
    </div>
  );
}
