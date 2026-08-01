import { useEffect, useRef } from "react";
import { useStore, type State } from "../store";
import type { CommandResult } from "../types";

type TransportControlsOptions = {
  exec: State["exec"];
  recording: boolean;
  anyArmed: boolean;
  fallbackTrackId?: string;
};

type RecordingCommandData = {
  applied?: boolean;
  clips?: unknown[];
  reason?: string;
};

function failureMessage(result: CommandResult, fallback: string): string {
  const data = result.data as RecordingCommandData | undefined;
  return result.error ?? data?.reason ?? fallback;
}

export function useTransportControls({
  exec,
  recording,
  anyArmed,
  fallbackTrackId,
}: TransportControlsOptions) {
  const recordingIntent = useRef(recording);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingActions = useRef(0);
  const visibleFailure = useRef<string | null>(null);

  useEffect(() => {
    recordingIntent.current = recording;
  }, [recording]);

  function showFailure(message: string): void {
    visibleFailure.current = message;
    useStore.setState({ lastError: message });
  }

  function enqueue(action: () => Promise<void>): Promise<void> {
    if (pendingActions.current === 0) visibleFailure.current = null;
    pendingActions.current += 1;
    const run = async () => {
      try {
        await action();
      } catch (error) {
        showFailure(error instanceof Error ? error.message : String(error));
      } finally {
        pendingActions.current -= 1;
        if (visibleFailure.current)
          useStore.setState({ lastError: visibleFailure.current });
      }
    };
    const next = queue.current.then(run, run);
    queue.current = next;
    return next;
  }

  async function stopRecording(): Promise<boolean> {
    const result = await exec("stop_recording");
    const data = result.data as RecordingCommandData | undefined;
    if (!result.ok) {
      showFailure(failureMessage(result, "Could not land the recording take."));
      return false;
    }
    recordingIntent.current = false;
    if (data?.applied === false) {
      showFailure(failureMessage(result, "Could not land the recording take."));
      return false;
    }
    const landedNoTake = Array.isArray(data?.clips) && data.clips.length === 0;
    if (landedNoTake) {
      showFailure(failureMessage(result, "Could not land the recording take."));
      return false;
    }
    return true;
  }

  return {
    record: () => enqueue(async () => {
      if (recordingIntent.current) {
        await stopRecording();
        return;
      }
      if (!anyArmed) {
        if (!fallbackTrackId) {
          showFailure("Add a track before recording.");
          return;
        }
        const arm = await exec("arm_track", { trackId: fallbackTrackId, armed: true });
        const armData = arm.data as RecordingCommandData | undefined;
        if (!arm.ok || armData?.applied === false) {
          showFailure(failureMessage(arm, "No audio input available — check your microphone connection and permissions."));
          return;
        }
      }
      const result = await exec("set_transport", { action: "record" });
      if (!result.ok) {
        showFailure(failureMessage(result, "Could not start recording."));
        return;
      }
      const state = result.data as { recording?: boolean } | undefined;
      if (state?.recording !== true) {
        recordingIntent.current = false;
        showFailure(failureMessage(result, "Could not start recording."));
        return;
      }
      recordingIntent.current = true;
    }),

    stop: () => enqueue(async () => {
      if (recordingIntent.current) {
        if (!await stopRecording()) return;
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
