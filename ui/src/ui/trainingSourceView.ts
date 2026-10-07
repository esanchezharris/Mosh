// Pure TrainingSource → the words the LoRA popover's Sources list shows for it
// (TopbarTools › TrainingTool). Same split as trainingJobView.ts: the component
// stays a thin paint over this testable derivation.
//
// `blocked_reason` is the first rule the source fails in native
// TrainerRegistry::sourceEligible (src/training/TrainerRegistry.cpp). Every reason
// that function can give is named here, in ONE place: the row badge and the blocker
// list under it used to keep separate partial maps, so the same source read
// "Needs approval" on its row and "Missing: not approved_for_training" below it.

import type { TrainingSource } from "../types";

// Native appends the path it looked for: "missing local file: /Users/…/beat.wav".
const MISSING_FILE = "missing local file";

/** What a blocked source needs, in the producer's words. */
export function trainingBlockedText(reason: string | undefined): string {
  switch (reason) {
    case "missing source_id": return "Missing source id";
    case "missing title": return "Add a title";
    case "missing creator": return "Add a creator";
    case "missing user_claimed_license": return "Add your claimed license text";
    case "missing proof_of_rights": return "Add rights proof";
    case "not approved_for_training": return "Needs approval";
    case "missing source_url or local_path":
    case "missing local_path": return "Add a local file";
  }
  if (reason?.startsWith(MISSING_FILE)) {
    const path = reason.slice(MISSING_FILE.length).replace(/^:\s*/, "");
    const name = path.split(/[\\/]/).pop() ?? "";
    return name ? `Local file not found: ${name}` : "Local file not found";
  }
  // A reason this build does not know is shown as the registry worded it.
  return reason || "Needs review";
}

/** The status badge on a source's row. */
export function trainingSourceStatus(source: TrainingSource): string {
  return source.eligible ? "Ready for training" : trainingBlockedText(source.blocked_reason);
}
