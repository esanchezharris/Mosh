import { useState } from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";

/** Pure visibility rule (testable without a DOM): show whenever the backend reported an
 *  audio-device problem and the user hasn't dismissed it this session. */
export function shouldShowAudioDeviceNotice(snapshot: Snapshot | null, dismissed: boolean): boolean {
  return Boolean(snapshot?.session.audioDeviceError) && !dismissed;
}

/** AUD-017 — the visible half of the bounded audio-device startup.
 *
 *  Before this, a device that would not open took the whole app down: the message thread
 *  blocked inside CoreAudio before the window existed, so the user saw a bouncing dock
 *  icon and nothing else, forever. Startup is now bounded — the app comes up WITHOUT
 *  audio and says so here. Retry re-runs the same bounded open, so the fix is
 *  "unplug the bad interface, press Retry", not "find Activity Monitor and restart
 *  coreaudiod as root". */
export function AudioDeviceNotice() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (!shouldShowAudioDeviceNotice(snapshot, dismissed)) return null;

  const onRetry = async () => {
    setRetrying(true);
    try {
      await exec("retry_audio_device", {});
      await refresh();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="error-bar" role="alert" data-testid="audio-device-notice">
      🔇 {snapshot?.session.audioDeviceError}
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        style={{ marginLeft: 8 }}
        data-testid="audio-device-retry"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
      <button type="button" onClick={() => setDismissed(true)} style={{ marginLeft: 8 }}>
        Dismiss
      </button>
    </div>
  );
}
