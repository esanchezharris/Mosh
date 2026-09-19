import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import { QrImage } from "../ui/QrImage";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useV3 } from "./shellState";

// V3's phone-pad pairing dialog — the desktop half of the Moshi phone pad. Built on V3's
// own modal chrome (modal-root / scrim / modal glass / modal-hd / icon-x), like
// MultiplayerLauncher; the triggers live in TopBar and in the Booth.
//
// The QR encodes `pairing.padUrl` and nothing else: the LAN-IP Safari pad at
// /pad#token=… . `pairingUrl` is a mosh:// deep link an iPhone cannot open without the
// native companion app installed, and a .local host does not resolve from a phone — both
// are dead ends at exactly the moment the producer is holding the phone up to the screen.
export function PhoneLauncher() {
  const open = useV3((s) => s.phoneOpen);
  const setOpen = useV3((s) => s.setPhoneOpen);
  const pairing = useStore((s) => s.remoteStatus?.pairing);
  const start = useStore((s) => s.startRemotePairing);
  const stop = useStore((s) => s.stopRemote);
  const lastError = useStore((s) => s.lastError);
  const setLastError = useStore((s) => s.setLastError);
  const closeRef = useRef<HTMLButtonElement>(null);
  const startedRef = useRef(false);
  const close = useCallback(() => setOpen(false), [setOpen]);

  useEscapeToClose(open, close);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);

  // Start the server on open, ONCE. The native call binds the listener and mints the
  // token, so by the time `pairing` lands the server is already accepting — there is
  // nothing to poll for. A failed start is reported, not retried in a loop.
  //
  // Clear the GLOBAL error first. `lastError` is the whole app's one error slot, so a
  // loop command that failed a minute ago is still in it when this dialog opens — and the
  // body below renders any lastError as "Could not start the phone server: …". Without
  // this the producer is sent hunting for a port conflict over a message about something
  // else entirely. A real start failure re-sets it through the same slot a moment later.
  useEffect(() => {
    if (!open) { startedRef.current = false; return; }
    if (startedRef.current || pairing) return;
    startedRef.current = true;
    setLastError(null);
    void start();
  }, [open, pairing, start, setLastError]);

  if (!open) return null;
  return (
    <div className="modal-root" data-testid="v3-phone-root">
      <div className="scrim" onClick={close} data-testid="v3-phone-backdrop" />
      <div className="modal glass" role="dialog" aria-modal="true" aria-label="Moshi phone pad"
        data-testid="v3-phone-modal">
        <div className="modal-hd">
          <b>Phone pad</b>
          <button ref={closeRef} type="button" className="icon-x" aria-label="Close" onClick={close}>×</button>
        </div>
        <div className="modal-body phone-body">
          {pairing ? (
            <>
              <QrImage url={pairing.padUrl} className="phone-qr" waitClassName="phone-qr-wait"
                alt="Moshi phone pad pairing QR" testId="v3-phone-qr" />
              <div className="set-hint">Scan with the iPhone Camera. Opens in Safari — no app to install.</div>
              <div className="phone-url" data-testid="v3-phone-url">{pairing.padUrl}</div>
              <div className="set-hint">
                Phone must be on the same Wi-Fi as this Mac. Reloading the page needs a new scan.
              </div>
            </>
          ) : (
            <div className="set-hint" role="status" aria-live="polite" data-testid="v3-phone-status">
              {lastError ? `Could not start the phone server: ${lastError}` : "Starting the phone server…"}
            </div>
          )}
          <div className="row" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {pairing && (
              <button type="button" className="btn" data-testid="v3-phone-stop"
                onClick={() => { void stop(); close(); }}>Stop</button>
            )}
            <button type="button" className="btn" data-testid="v3-phone-done" onClick={close}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
