import { useBrainRuntime } from "../hooks/useBrainRuntime";

const transitionStates = new Set(["cleaning", "starting", "stopping"]);

export function LocalAiToggle() {
  const { status, start, stop } = useBrainRuntime();
  const on = status.state === "ready" || status.state === "prewarming";
  const transitioning = transitionStates.has(status.state);
  const disabled = !status.configured || transitioning;
  const title = status.error || (() => {
    switch (status.state) {
      case "off": return "Start the local Mosh model for this app session";
      case "cleaning": return "Cleaning up an owned local model process";
      case "starting": return "Starting the local Mosh model";
      case "ready": return "Local AI is on. Click to release its memory";
      case "prewarming": return "Local AI is prewarming. Click to release its memory";
      case "stopping": return "Stopping local AI and releasing its memory";
      case "error": return "Local AI needs attention";
      case "unavailable": return "Local AI is not configured";
    }
  })();
  return <button
    className="v2-btn v2-local-ai"
    type="button"
    aria-label="Local AI"
    aria-pressed={on}
    data-on={on}
    data-state={status.state}
    disabled={disabled}
    title={title}
    onClick={() => void (on ? stop() : start())}
  >
    <span className="v2-local-ai-dot" aria-hidden="true" />
    <span>LOCAL AI</span>
  </button>;
}
