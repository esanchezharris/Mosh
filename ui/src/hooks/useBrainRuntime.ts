import { useCallback, useSyncExternalStore } from "react";
import {
  brainRuntimeStart,
  brainRuntimeStatus,
  brainRuntimeStop,
  onEvent,
  parseBrainRuntimeStatus,
  type BrainRuntimeStatus,
} from "../bridge";

type Listener = () => void;

let currentStatus: BrainRuntimeStatus = {
  configured: false,
  state: "unavailable",
  error: "owner runtime is native-only",
};
let revision = 0;
let stopEvents: (() => void) | undefined;
const listeners = new Set<Listener>();

function publish(status: BrainRuntimeStatus): void {
  if (currentStatus.configured === status.configured
      && currentStatus.state === status.state
      && currentStatus.model === status.model
      && currentStatus.endpoint === status.endpoint
      && currentStatus.port === status.port
      && currentStatus.error === status.error
      && currentStatus.ms === status.ms
      && currentStatus.preferredShell === status.preferredShell) return;
  currentStatus = status;
  revision += 1;
  for (const listener of listeners) listener();
}

function startSubscription(): void {
  if (stopEvents) return;
  stopEvents = onEvent("brain_runtime", (payload) => publish(parseBrainRuntimeStatus(payload)));
  const bootstrapRevision = revision;
  void brainRuntimeStatus()
    .then((status) => {
      if (revision === bootstrapRevision) publish(status);
    })
    .catch((error: unknown) => {
      if (revision !== bootstrapRevision) return;
      publish({
        configured: false,
        state: "unavailable",
        error: error instanceof Error ? error.message : "Local AI status is unavailable",
      });
    });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  startSubscription();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopEvents) {
      stopEvents();
      stopEvents = undefined;
    }
  };
}

function snapshot(): BrainRuntimeStatus {
  return currentStatus;
}

export function useBrainRuntime() {
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);
  const start = useCallback(async (): Promise<void> => {
    try {
      publish(await brainRuntimeStart());
    } catch (error: unknown) {
      publish({
        configured: true,
        state: "error",
        error: error instanceof Error ? error.message : "Local AI could not start",
      });
    }
  }, []);
  const stop = useCallback(async (): Promise<void> => {
    try {
      publish(await brainRuntimeStop());
    } catch (error: unknown) {
      publish({
        configured: true,
        state: "error",
        error: error instanceof Error ? error.message : "Local AI could not stop",
      });
    }
  }, []);
  return { status, start, stop };
}
