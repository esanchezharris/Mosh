import { describe, expect, it } from "vitest";
import { runOwnerCockpitIntegration } from "../src/integration-harness.js";

describe("owner cockpit bundled integration harness", () => {
  it("drives the complete fake-external playtest lifecycle over real loopback HTTP", async () => {
    const result = await runOwnerCockpitIntegration();

    expect(result.verdict).toBe("passed");
    expect(result.host).toBe("127.0.0.1");
    expect(result.externalWrites).toEqual({
      beforeApproval: 0,
      evidence: 1,
      github: 1,
      codexThreads: 2,
      gitWorktrees: 1,
      processActions: 0,
      live: 0,
    });
    expect(result.supervisor).toMatchObject({
      selectedCapabilityIds: ["set_metronome"],
      commands: [{ capabilityId: "set_metronome" }],
    });
    expect(result.repair).toMatchObject({
      status: "running",
      branch: "codex/playtest-42-metronome-drift",
    });
    expect(result.events).toEqual(expect.arrayContaining([
      "playtest.created",
      "supervisor.turn.completed",
      "report.created",
      "report.approved",
      "evidence.uploaded",
      "report.sync.completed",
      "codex.coordinator.started",
      "codex.progress",
      "repair.reserved",
      "repair.started",
      "repair.codex.progress",
      "playtest.closed",
    ]));
    expect(result.retention).toEqual({
      transcriptPurged: true,
      sdkSessionPurged: true,
      reportRetained: true,
      repairRetained: true,
      auditRetained: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /OPENAI_API_KEY|MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET|Authorization|Bearer\s|sk-[A-Za-z0-9_-]+/,
    );
  });
});
