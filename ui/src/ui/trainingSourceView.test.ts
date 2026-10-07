import { describe, it, expect } from "vitest";
import { trainingBlockedText, trainingSourceStatus } from "./trainingSourceView";
import type { TrainingSource } from "../types";

// Pure derivation the LoRA popover's Sources list paints with (same convention as
// trainingJobView.test.ts). The inputs are the exact strings native
// TrainerRegistry::sourceEligible produces — the popover used to keep two partial
// maps of them, so a source waiting on approval read "Needs approval" on its row and
// "Missing: not approved_for_training" in the blocker list under it.

const source = (over: Partial<TrainingSource>): TrainingSource => ({
  index: 0,
  source_id: "beat-001",
  title: "Beat",
  creator: "Me",
  source_url: "",
  local_path: "/Users/you/beat.wav",
  user_claimed_license: "mine",
  proof_of_rights: "session files",
  approved_for_training: true,
  notes: "",
  eligible: true,
  blocked_reason: "",
  ...over,
});

describe("trainingBlockedText", () => {
  it("says what to do for every reason native sourceEligible can give", () => {
    expect(trainingBlockedText("missing source_id")).toBe("Missing source id");
    expect(trainingBlockedText("missing title")).toBe("Add a title");
    expect(trainingBlockedText("missing creator")).toBe("Add a creator");
    expect(trainingBlockedText("missing user_claimed_license")).toBe("Add your claimed license text");
    expect(trainingBlockedText("missing proof_of_rights")).toBe("Add rights proof");
    expect(trainingBlockedText("missing source_url or local_path")).toBe("Add a local file");
    expect(trainingBlockedText("not approved_for_training")).toBe("Needs approval");
    expect(trainingBlockedText("missing local_path")).toBe("Add a local file");
  });

  it("recognises the missing-file reason, which arrives with the path appended", () => {
    expect(trainingBlockedText("missing local file: /Users/you/Beats/dark 808.wav"))
      .toBe("Local file not found: dark 808.wav");
    expect(trainingBlockedText("missing local file: E:\\beats\\dark.wav")).toBe("Local file not found: dark.wav");
    expect(trainingBlockedText("missing local file")).toBe("Local file not found");
  });

  it("shows a reason it does not know as-is, never dressed up as a missing field", () => {
    expect(trainingBlockedText("license expired")).toBe("license expired");
    expect(trainingBlockedText("")).toBe("Needs review");
    expect(trainingBlockedText(undefined)).toBe("Needs review");
  });
});

describe("trainingSourceStatus", () => {
  it("is ready when the source is eligible, whatever reason text lingers", () => {
    expect(trainingSourceStatus(source({}))).toBe("Ready for training");
    expect(trainingSourceStatus(source({ eligible: true, blocked_reason: "missing title" }))).toBe("Ready for training");
  });

  it("is the blocked text otherwise — the same words the blocker list uses", () => {
    const blocked = source({ eligible: false, approved_for_training: false, blocked_reason: "not approved_for_training" });
    expect(trainingSourceStatus(blocked)).toBe(trainingBlockedText(blocked.blocked_reason));
    expect(trainingSourceStatus(blocked)).toBe("Needs approval");
    // A source from a backend that predates eligibility is not ready.
    expect(trainingSourceStatus(source({ eligible: undefined, blocked_reason: undefined }))).toBe("Needs review");
  });
});
