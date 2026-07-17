// Pure guest-degradation capability-gating helpers. Kept separate from store.ts so the
// gating RULES (not just the fetch/store plumbing) are directly unit-testable, and so
// every UI surface that needs to know "is the AI setup installed on this Mac" reads the
// same logic instead of re-deriving it ad hoc. Backed by service/server.py's
// _guest_capability_summary(), piggybacked onto GET /transform_targets and loaded once
// at app init via store.ts's loadCapabilities() (see that file for why THAT endpoint).
import type { ServiceCapabilities } from "./types";

// The clip-menu's audio-source actions (Convert to MIDI / Build lyrics from this take /
// Build flow from this take) all ultimately need Basic Pitch (transcribe) to detect
// notes — skeleton/whisper/phonology are upgrades layered on top of a Basic-Pitch note
// list, never a substitute for it. `null`/`undefined` (capabilities not loaded yet, or
// an older service that predates the field) is treated as enabled: the common case, and
// a slow first fetch must never flash-disable a feature that actually works.
export function transcriptionMenuEnabled(capabilities: ServiceCapabilities | null | undefined): boolean {
  if (!capabilities) return true;
  return capabilities.transcribe !== false;
}

// Tooltip on a disabled clip-menu AI action — progressive disclosure (stay visible +
// discoverable, don't just vanish) rather than hiding the feature outright.
export const AI_SETUP_HINT = "needs the AI setup — run setup-guest.sh";

// Whether the transform target picker is running the deterministic fake tilt/saturation
// stand-in rather than a real installed RAVE model. Unresolved capabilities -> assume
// real (no label) rather than flash a "preview" tag that a moment later proves wrong.
export function isTransformPreview(capabilities: ServiceCapabilities | null | undefined): boolean {
  if (!capabilities) return false;
  return capabilities.transformReal === false;
}

// The Type-beat Training popover always drives the deterministic fake trainer unless
// the owner has pointed the service at a remote GPU box (MOSH_TRAINING_REMOTE_URL /
// MOSH_TRAINING_BACKEND=remote). Returns a short label to show by the popover title, or
// null when nothing should show (a real remote backend, or capabilities unresolved).
export function trainingPreviewLabel(capabilities: ServiceCapabilities | null | undefined): string | null {
  const backend = capabilities?.trainingBackend;
  if (!backend) return null;
  return backend === "remote_http" ? null : "preview";
}
