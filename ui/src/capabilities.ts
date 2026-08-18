// Pure guest-degradation capability-gating helpers. Kept separate from store.ts so the
// gating RULES (not just the fetch/store plumbing) are directly unit-testable, and so
// every UI surface that needs to know "is the AI setup installed on this Mac" reads the
// same logic instead of re-deriving it ad hoc. Backed by service/server.py's
// _guest_capability_summary(), piggybacked onto GET /transform_targets and loaded
// LAZILY (first clip-menu/Gen-drawer open — never at app init, which must stay free of
// any command that can spawn the generative service) via store.ts's loadCapabilities()
// (see that file for why THAT endpoint, and why the fetch must never be eager).
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

// Whether the training popover is driving a STUB rather than something that
// produces a real adapter. Two backends are real: "remote_http" (a rented GPU)
// and "local_pmetal" (an actual fine-tune on this Mac, via the bundled trainer,
// producing a .safetensors the render path loads unmodified). Only "fake" — the
// deterministic JSON stub — earns the label.
//
// This comment used to say the popover "always drives the deterministic fake
// trainer unless ... a remote GPU box", which was true until the local trainer
// landed and is exactly the kind of stale claim-about-the-code worth correcting
// rather than leaving to mislead the next reader.
const REAL_TRAINING_BACKENDS = new Set(["remote_http", "local_pmetal"]);

export function trainingPreviewLabel(capabilities: ServiceCapabilities | null | undefined): string | null {
  const backend = capabilities?.trainingBackend;
  if (!backend) return null;
  return REAL_TRAINING_BACKENDS.has(backend) ? null : "preview";
}

// Why a real backend still can't train right now — e.g. the SA3 base checkpoint
// is missing. Empty when training is ready or the backend is the stub (whose
// only honest signal is the "preview" label above).
export function trainingBlockers(capabilities: ServiceCapabilities | null | undefined): string[] {
  return capabilities?.trainingBlockers ?? [];
}
