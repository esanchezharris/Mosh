import { useRef } from "react";
import { useStore, type State } from "../store";
import type { CommandResult } from "../types";
import { landedRecordingClipIds, type RecordingCommandData } from "../recordingLifecycle";
import { enqueueTransportAction } from "../transportActionQueue";

type TransportControlsOptions = {
  exec: State["exec"];
  anyArmed: boolean;
  fallbackTrackId?: string;
};

function failureMessage(result: CommandResult, fallback: string): string {
  const data = result.data as RecordingCommandData | undefined;
  return result.error ?? data?.reason ?? fallback;
}

export function useTransportControls({
  exec,
  anyArmed,
  fallbackTrackId,
}: TransportControlsOptions) {
  const pendingActions = useRef(0);
  const visibleFailure = useRef<string | null>(null);

  function showFailure(message: string): void {
    visibleFailure.current = message;
    useStore.setState({ lastError: message });
  }

  function enqueue(action: () => Promise<void>): Promise<void> {
    if (pendingActions.current === 0) visibleFailure.current = null;
    pendingActions.current += 1;
    const run = async () => {
      try {
        if (useStore.getState().projectTransitioning) {
          showFailure("Wait for the project to finish opening before using transport controls.");
          return;
        }
        await action();
      } catch (error) {
        showFailure(error instanceof Error ? error.message : String(error));
      }
    };
    return enqueueTransportAction(run).finally(() => {
      pendingActions.current -= 1;
      if (visibleFailure.current)
        useStore.setState({ lastError: visibleFailure.current });
    });
  }

  function projectIsCurrent(projectEpoch: number): boolean {
    return useStore.getState().projectEpoch === projectEpoch;
  }

  async function stopRecording(projectEpoch: number): Promise<boolean> {
    const result = await exec("stop_recording");
    if (!projectIsCurrent(projectEpoch)) return false;
    if (!result.ok || result.command !== "stop_recording") {
      showFailure(failureMessage(result, "Could not land the recording take."));
      return false;
    }
    useStore.setState((state) => ({
      transport: { ...state.transport, playing: false, recording: false },
    }));
    if (!landedRecordingClipIds(result)) {
      showFailure(failureMessage(result, "Could not land the recording take."));
      return false;
    }
    return true;
  }

  return {
    record: () => {
      const projectEpoch = useStore.getState().projectEpoch;
      return enqueue(async () => {
        if (!projectIsCurrent(projectEpoch)) return;
        if (useStore.getState().transport.recording) {
          await stopRecording(projectEpoch);
          return;
        }
        if (!anyArmed) {
          if (!fallbackTrackId) {
            showFailure("Add a track before recording.");
            return;
          }
          const arm = await exec("arm_track", { trackId: fallbackTrackId, armed: true });
          if (!projectIsCurrent(projectEpoch)) return;
          const armData = arm.data as RecordingCommandData | undefined;
          if (!arm.ok || arm.command !== "arm_track" || armData?.applied !== true) {
            // The engine's applied:false reason is the hardcoded generic "no input
            // device" — show the GUIDED message instead (names why AND the fix).
            // A hard command error (arm.error) still rides through verbatim.
            showFailure(arm.error ?? "No usable audio input — check Settings → Audio (device and input selection).");
            return;
          }
        }
        const result = await exec("set_transport", { action: "record" });
        if (!projectIsCurrent(projectEpoch)) return;
        if (!result.ok || result.command !== "set_transport") {
          showFailure(failureMessage(result, "Could not start recording."));
          return;
        }
        const state = result.data as { playing?: boolean; recording?: boolean } | undefined;
        if (state?.recording !== true) {
          showFailure(failureMessage(result, "Could not start recording."));
          return;
        }
        useStore.setState((store) => ({
          transport: {
            ...store.transport,
            recording: true,
            ...(typeof state.playing === "boolean" ? { playing: state.playing } : {}),
          },
        }));
      });
    },

    stop: () => {
      const projectEpoch = useStore.getState().projectEpoch;
      return enqueue(async () => {
        if (!projectIsCurrent(projectEpoch)) return;
        if (useStore.getState().transport.recording) {
          if (!await stopRecording(projectEpoch) || !projectIsCurrent(projectEpoch)) return;
          await exec("set_transport", { position: 0 });
          return;
        }
        const result = await exec("set_transport", { action: "stop", position: 0 });
        if (!projectIsCurrent(projectEpoch)) return;
        if (result.ok) {
          useStore.setState((state) => ({
            transport: { ...state.transport, playing: false, recording: false, position: 0 },
          }));
        }
      });
    },

    togglePlay: () => {
      const projectEpoch = useStore.getState().projectEpoch;
      return enqueue(async () => {
        if (!projectIsCurrent(projectEpoch)) return;
        if (useStore.getState().transport.recording) {
          await stopRecording(projectEpoch);
          return;
        }
        const result = await exec("set_transport", { action: "toggle" });
        if (!projectIsCurrent(projectEpoch)) return;
        const state = result.data as { recording?: boolean } | undefined;
        if (result.ok && typeof state?.recording === "boolean") {
          useStore.setState((store) => ({
            transport: { ...store.transport, recording: state.recording! },
          }));
        }
      });
    },
  };
}
