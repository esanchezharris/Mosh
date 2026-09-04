// LOCAL AI — the top-bar switch for the owner's local MLX model.
//
// Lifted from #678's UI, repointed at the native contract that actually shipped (#695,
// on top of #677's spawn ledger). Two deliberate differences from the original:
//
//  * No `configured` field. #678's native side published one; #695's does not. It does
//    not need to: OwnerRuntime publishes state "unavailable" with an error exactly when
//    the model or Python runtime is missing, so that state IS "not configured".
//  * No "cleaning"/"stopping" states. Those belonged to #678's own process registry.
//    OwnerRuntime emits off | starting | ready | prewarming | error | unavailable, and
//    rendering a state the backend cannot produce would be dead code that implies a
//    transition we do not have.
//
// The model is ~17GB, so this is the difference between a launch that costs nothing and
// one that does not — which is why it is OFF until pressed (owner decision 2026-09-03).
import { useBrainRuntime } from "../hooks/useBrainRuntime";

const TITLES: Record<string, string> = {
  off: "Start the local Mosh model for this app session",
  starting: "Starting the local Mosh model",
  ready: "Local AI is on. Click to release its memory",
  prewarming: "Local AI is prewarming. Click to release its memory",
  error: "Local AI needs attention",
  unavailable: "Local AI is not configured",
};

export function LocalAiToggle() {
  const { status, start, stop } = useBrainRuntime();
  const on = status.state === "ready" || status.state === "prewarming";
  // "starting" is in flight: pressing again would spawn a second 17GB load.
  const disabled = status.state === "unavailable" || status.state === "starting";
  return <button
    className="v2-btn v2-local-ai"
    type="button"
    aria-label="Local AI"
    aria-pressed={on}
    data-on={on}
    data-state={status.state}
    disabled={disabled}
    title={status.error || TITLES[status.state] || "Local AI"}
    onClick={() => void (on ? stop() : start())}
  >
    <span className="v2-local-ai-dot" aria-hidden="true" />
    <span>LOCAL AI</span>
  </button>;
}
