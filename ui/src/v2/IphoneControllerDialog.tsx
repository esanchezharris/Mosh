// "Set up iPhone controller" — the one-click path from a track's context menu to a
// phone that can drive the recording loop.
//
// Why this exists as a dialog rather than another topbar popover: the phone is set up
// mid-session, from the track you are about to sing on, and the old route (topbar
// "iPhone" -> Start pairing) buried it away from that moment.
//
// The QR encodes `pairing.webUrl` — the no-install Safari pad at /web — NOT the
// `mosh://pair` deep link, which iOS cannot open unless the native MoshCompanion app
// is installed. The host inside both URLs comes from RemoteCompanionServer::
// pairingUrlHost(), which resolves to the LAN IPv4 precisely so the phone can reach it.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import * as QRCode from "qrcode";
import { useStore } from "../store";

function Qr({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState("");
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: "#0b0b0b", light: "#ccff23" } })
      .then((d) => { if (!cancelled) setDataUrl(d); })
      .catch(() => { if (!cancelled) setDataUrl(""); });
    return () => { cancelled = true; };
  }, [url]);
  return dataUrl
    ? <img className="v2-iphone-qr" src={dataUrl} alt="iPhone controller pairing QR" data-testid="v2-iphone-qr" />
    : <div className="v2-iphone-qr-wait" aria-hidden="true" />;
}

export function IphoneControllerDialog({ onClose }: { onClose: () => void }) {
  const remote = useStore((s) => s.remoteStatus);
  const start = useStore((s) => s.startRemotePairing);
  const stop = useStore((s) => s.stopRemote);
  const lastError = useStore((s) => s.lastError);
  const [started, setStarted] = useState(false);

  // Start pairing on open. The native call binds the listener and mints the token, so
  // by the time `pairing` lands the server is already accepting — there is nothing to
  // poll for and no token to probe (unlike an out-of-process script, which cannot know
  // a running server's token).
  useEffect(() => {
    if (started) return;
    setStarted(true);
    void start();
  }, [start, started]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pairing = remote?.pairing;

  return createPortal(
    <div className="v2-iphone-scrim" onPointerDown={onClose} data-testid="v2-iphone-scrim">
      <div
        className="v2-iphone-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Set up iPhone controller"
        data-testid="v2-iphone-dialog"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="v2-iphone-head">iPhone controller</div>

        {pairing ? (
          <>
            <Qr url={pairing.webUrl} />
            <div className="v2-iphone-note">
              Scan with the iPhone Camera. Opens in Safari — no app to install.
            </div>
            <div className="v2-iphone-url" data-testid="v2-iphone-url">{pairing.webUrl}</div>
            <div className="v2-iphone-note v2-iphone-dim">
              Phone must be on the same Wi-Fi as this Mac.
            </div>
          </>
        ) : (
          <div className="v2-iphone-note" role="status" aria-live="polite" data-testid="v2-iphone-status">
            {lastError ? `Could not start the companion server: ${lastError}` : "Starting the companion server…"}
          </div>
        )}

        <div className="v2-iphone-actions">
          {pairing && (
            <button type="button" className="btn" onClick={() => { void stop(); onClose(); }} data-testid="v2-iphone-stop">
              Stop
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} data-testid="v2-iphone-close">Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
