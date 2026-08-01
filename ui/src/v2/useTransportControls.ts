import { useEffect, useRef } from "react";
import type { State } from "../store";

type TransportControlsOptions = {
  exec: State["exec"];
  recording: boolean;
  anyArmed: boolean;
  fallbackTrackId?: string;
};

export function useTransportControls({
  exec,
  recording,
  anyArmed,
  fallbackTrackId,
}: TransportControlsOptions) {
  const recordingIntent = useRef(recording);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    recordingIntent.current = recording;
  }, [recording]);

  function enqueue(action: () => Promise<void>): Promise<void> {
    const next = queue.current.then(action, action);
    queue.current = next.catch(() => {});
    return next;
  }

  async function stopRecording(): Promise<void> {
    const result = await exec("stop_recording");
    if (result.ok) recordingIntent.current = false;
  }

  return {
    record: () => enqueue(async () => {
      if (recordingIntent.current) {
        await stopRecording();
        return;
      }
      if (!anyArmed && fallbackTrackId)
        await exec("arm_track", { trackId: fallbackTrackId, armed: true });
      const result = await exec("set_transport", { action: "record" });
      const state = result.data as { recording?: boolean } | undefined;
      recordingIntent.current = result.ok && state?.recording === true;
    }),

    stop: () => enqueue(async () => {
      if (recordingIntent.current) {
        await stopRecording();
        await exec("set_transport", { position: 0 });
        return;
      }
      const result = await exec("set_transport", { action: "stop", position: 0 });
      if (result.ok) recordingIntent.current = false;
    }),

    togglePlay: () => enqueue(async () => {
      if (recordingIntent.current) {
        await stopRecording();
        return;
      }
      const result = await exec("set_transport", { action: "toggle" });
      const state = result.data as { recording?: boolean } | undefined;
      if (result.ok && typeof state?.recording === "boolean")
        recordingIntent.current = state.recording;
    }),
  };
}
