import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult, TrainingSource } from "./types";

// Rights registry — every training source carries `eligible` + `blocked_reason`, as
// native TrainerRegistry::sourceSummary emits them. The LoRA Lab's Train button and
// the training popover's per-source status both read them, so a mock that leaves them
// unset renders every source blocked and Train permanently disabled in dev and e2e.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const sources = async () => (await mockSnapshot<Snapshot>()).training?.sources ?? [];

const COMPLETE = {
  sourceId: "beat-a",
  title: "Beat A",
  creator: "Me",
  localPath: "/Users/you/beat-a.wav",
  userClaimedLicense: "I made this",
  proofOfRights: "session files",
};

describe("mock training-source eligibility", () => {
  beforeEach(() => __resetMockForTests());

  it("a complete source is blocked only on approval, and approving it makes it eligible", async () => {
    const imported = (await exec("import_training_source", COMPLETE)).data as { source: TrainingSource };
    expect(imported.source).toMatchObject({ eligible: false, blocked_reason: "not approved_for_training" });

    const approved = (await exec("approve_training_source", { sourceId: "beat-a" })).data as { source: TrainingSource };
    expect(approved.source).toMatchObject({ eligible: true, blocked_reason: "" });

    // Both read paths the UI uses agree with the write results.
    const listed = (await exec("list_training_sources")).data as { sources: TrainingSource[] };
    expect(listed.sources).toMatchObject([{ source_id: "beat-a", eligible: true, blocked_reason: "" }]);
    expect(await sources()).toMatchObject([{ source_id: "beat-a", eligible: true, blocked_reason: "" }]);

    await exec("approve_training_source", { sourceId: "beat-a", approved: false });
    expect(await sources()).toMatchObject([{ eligible: false, blocked_reason: "not approved_for_training" }]);
  });

  it("names the first failing rule, in native sourceEligible order", async () => {
    const reasonFor = async (overrides: Record<string, unknown>) => {
      await exec("import_training_source", { ...COMPLETE, approvedForTraining: true, ...overrides });
      return (await sources())[0].blocked_reason;
    };
    expect(await reasonFor({})).toBe("");
    expect(await reasonFor({ localPath: "", sourceUrl: "https://example.com/beat" })).toBe("missing local_path");
    expect(await reasonFor({ localPath: "", approvedForTraining: false })).toBe("not approved_for_training");
    expect(await reasonFor({ proofOfRights: "", approvedForTraining: false })).toBe("missing proof_of_rights");
    expect(await reasonFor({ userClaimedLicense: "", proofOfRights: "" })).toBe("missing user_claimed_license");
    expect(await reasonFor({ creator: "", userClaimedLicense: "" })).toBe("missing creator");
    expect(await reasonFor({ title: "", creator: "" })).toBe("missing title");
    // license_name is the legacy spelling of the claim (native claimedLicense falls back to it).
    expect(await reasonFor({ userClaimedLicense: undefined, licenseName: "CC-BY" })).toBe("");
  });

  it("build_training_corpus takes exactly the eligible sources and reports why it skipped the rest", async () => {
    await exec("import_training_source", { ...COMPLETE, approvedForTraining: true });
    await exec("import_training_source", { ...COMPLETE, sourceId: "beat-b", approvedForTraining: true, proofOfRights: "" });
    const built = (await exec("build_training_corpus")).data as {
      sourceCount: number; sources: { source_id: string }[]; skippedSources: { source_id: string; reason: string }[];
    };
    expect(built.sourceCount).toBe(1);
    expect(built.sources.map((s) => s.source_id)).toEqual(["beat-a"]);
    expect(built.skippedSources).toEqual([{ source_id: "beat-b", reason: "missing proof_of_rights" }]);
  });
});
