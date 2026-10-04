import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult, TrainingSource } from "./types";

// The training popover's source rows and the LoRA Lab's Train button render from
// snapshot.training.sources: `eligible` decides the status badge, whether Build
// enables, and the "N clips" Train counts. Native stamps `eligible` and
// `blocked_reason` on every source (TrainerRegistry::sourceSummary) and now carries
// the registry in its snapshot. The mock left both fields off, so in dev and e2e
// every source read as blocked, an approved one included.
//
// The reasons and their order are TrainerRegistry::sourceEligible's. The one check
// a browser cannot make is its last: whether the file is really on disk.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const sources = async () => (await mockSnapshot<Snapshot>()).training?.sources ?? [];
const complete = {
  title: "Beat", creator: "Me", localPath: "/beats/beat.wav",
  userClaimedLicense: "own work", proofOfRights: "made it",
};

describe("mock training sources", () => {
  beforeEach(() => __resetMockForTests());

  it("a new source is in the snapshot, blocked on approval", async () => {
    const r = await exec("import_training_source", complete);
    expect(r.ok).toBe(true);
    const [s] = await sources();
    expect(s.title).toBe("Beat");
    expect(s.eligible).toBe(false);
    expect(s.blocked_reason).toBe("not approved_for_training");
  });

  it("approving it makes it eligible — what the Lab's Train button counts", async () => {
    await exec("import_training_source", complete);
    const [before] = await sources();
    const r = await exec("approve_training_source", { sourceId: before.source_id, approved: true });
    expect(r.ok).toBe(true);
    const [s] = await sources();
    expect(s.approved_for_training).toBe(true);
    expect(s.eligible).toBe(true);
    expect(s.blocked_reason).toBe("");
    expect((await sources()).filter((x) => x.eligible)).toHaveLength(1);

    await exec("approve_training_source", { sourceId: s.source_id, approved: false });
    expect((await sources())[0].eligible).toBe(false);
  });

  it("names what a source is missing, in native's order", async () => {
    const reasonFor = async (args: Record<string, unknown>) => {
      __resetMockForTests();
      await exec("import_training_source", { ...complete, approvedForTraining: true, ...args });
      return (await sources())[0].blocked_reason;
    };
    expect(await reasonFor({ userClaimedLicense: "" })).toBe("missing user_claimed_license");
    expect(await reasonFor({ proofOfRights: "" })).toBe("missing proof_of_rights");
    expect(await reasonFor({ userClaimedLicense: "", proofOfRights: "" })).toBe("missing user_claimed_license");
    // A discovery link alone is not something to train on.
    expect(await reasonFor({ localPath: "", sourceUrl: "https://example.invalid/beat" })).toBe("missing local_path");
    expect(await reasonFor({})).toBe("");
  });

  it("answers import, approve and list with the source itself, as native does", async () => {
    const imported = (await exec("import_training_source", complete)).data as TrainingSource;
    expect(imported.source_id).toBe("beat-001");
    expect(imported.index).toBe(0);
    expect(imported.eligible).toBe(false);

    const approved = (await exec("approve_training_source", { sourceId: "beat-001" })).data as TrainingSource;
    expect(approved.eligible).toBe(true);

    const listed = (await exec("list_training_sources")).data as { sources: TrainingSource[]; sourceCount: number };
    expect(listed.sourceCount).toBe(1);
    expect(listed.sources[0].eligible).toBe(true);
  });

  it("re-importing a source keeps its slot", async () => {
    await exec("import_training_source", { ...complete, sourceId: "alpha" });
    await exec("import_training_source", { ...complete, sourceId: "beta" });
    const again = (await exec("import_training_source", { ...complete, sourceId: "alpha", title: "Alpha v2" })).data as TrainingSource;
    expect(again.index).toBe(0);
    expect((await sources()).map((s) => [s.index, s.source_id, s.title]))
      .toEqual([[0, "alpha", "Alpha v2"], [1, "beta", "Beat"]]);
  });

  it("builds a corpus from the eligible sources and says why it skipped the rest", async () => {
    await exec("import_training_source", { ...complete, sourceId: "ready", approvedForTraining: true });
    await exec("import_training_source", { ...complete, sourceId: "unapproved" });
    await exec("import_training_source", { ...complete, sourceId: "no-proof", approvedForTraining: true, proofOfRights: "" });
    const r = await exec("build_training_corpus");
    expect(r.ok).toBe(true);
    const d = r.data as { sourceCount: number; skippedSources: { source_id: string; reason: string }[] };
    expect(d.sourceCount).toBe(1);
    expect(d.skippedSources).toEqual([
      { source_id: "unapproved", reason: "not approved_for_training" },
      { source_id: "no-proof", reason: "missing proof_of_rights" },
    ]);
  });
});
