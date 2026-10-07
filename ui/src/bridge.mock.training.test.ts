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
    // The result's data IS the source summary, as native okResult(command, summary) returns it.
    const imported = (await exec("import_training_source", COMPLETE)).data as TrainingSource;
    expect(imported).toMatchObject({ source_id: "beat-a", eligible: false, blocked_reason: "not approved_for_training" });

    const approved = (await exec("approve_training_source", { sourceId: "beat-a" })).data as TrainingSource;
    expect(approved).toMatchObject({ source_id: "beat-a", eligible: true, blocked_reason: "" });

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
    expect(await reasonFor({ localPath: "", sourceUrl: "https://example.com/beat", approvedForTraining: false }))
      .toBe("not approved_for_training");
    expect(await reasonFor({ proofOfRights: "", approvedForTraining: false })).toBe("missing proof_of_rights");
    expect(await reasonFor({ userClaimedLicense: "", proofOfRights: "" })).toBe("missing user_claimed_license");
    expect(await reasonFor({ creator: "", userClaimedLicense: "" })).toBe("missing creator");
    expect(await reasonFor({ title: "", creator: "" })).toBe("missing title");
    // license_name is the legacy spelling of the claim (native claimedLicense falls back to it).
    expect(await reasonFor({ userClaimedLicense: undefined, licenseName: "CC-BY" })).toBe("");
  });

  it("refuses an import with neither a URL nor a local file, and registers nothing", async () => {
    const r = await exec("import_training_source", { ...COMPLETE, localPath: "", sourceUrl: "" });
    expect(r).toMatchObject({ ok: false, error: "missing sourceUrl or localPath" });
    expect((await exec("import_training_source", { title: "No file", creator: "Me" })).ok).toBe(false);
    expect(await sources()).toEqual([]);
    // Either one alone is enough to register (a URL-only source is then blocked on its file).
    expect((await exec("import_training_source", { ...COMPLETE, localPath: "", sourceUrl: "https://example.com/b" })).ok).toBe(true);
  });

  it("re-importing an id replaces the record in its own slot", async () => {
    await exec("import_training_source", COMPLETE);
    await exec("import_training_source", { ...COMPLETE, sourceId: "beat-b" });
    const again = (await exec("import_training_source", { ...COMPLETE, title: "Beat A v2" })).data as TrainingSource;
    expect(again).toMatchObject({ source_id: "beat-a", title: "Beat A v2", index: 0 });
    expect((await sources()).map((s) => [s.index, s.source_id])).toEqual([[0, "beat-a"], [1, "beat-b"]]);
  });

  it("approve refuses a missing or unknown sourceId with native's wording", async () => {
    expect(await exec("approve_training_source", {})).toMatchObject({ ok: false, error: "missing sourceId" });
    expect(await exec("approve_training_source", { sourceId: "nope" }))
      .toMatchObject({ ok: false, error: "source not found: nope" });
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
