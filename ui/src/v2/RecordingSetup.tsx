import { useEffect, useState } from "react";
import {
  microphonePermissionStatus,
  requestMicrophonePermission,
  type MicrophonePermissionResult,
} from "../bridge";

export function RecordingSetup() {
  const [permission, setPermission] = useState<MicrophonePermissionResult | null>(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let active = true;
    void microphonePermissionStatus().then((result) => {
      if (active) setPermission(result);
    });
    return () => { active = false; };
  }, []);

  const request = async () => {
    setRequesting(true);
    const result = await requestMicrophonePermission();
    setPermission(result);
    setRequesting(false);
  };

  if (permission?.status === "granted") {
    return (
      <div className="v2-recording-setup ready" data-testid="recording-ready">
        <span className="v2-recording-title">Audio recording is ready</span>
        <span className="v2-recording-copy">Mosh will still start output-only every time.</span>
      </div>
    );
  }

  const unavailable = permission?.status === "denied" || permission?.status === "restricted";
  return (
    <div className="v2-recording-setup">
      <div>
        <span className="v2-recording-title">Record audio in this session</span>
        <span className="v2-recording-copy">
          {unavailable ? permission.error : "Optional. This is the only action here that asks for microphone access."}
        </span>
      </div>
      <button type="button" className="v2-recording-button" data-testid="recording-setup"
        disabled={requesting || unavailable} onClick={() => void request()}>
        {requesting ? "Waiting for macOS…" : "Set up audio recording"}
      </button>
    </div>
  );
}
