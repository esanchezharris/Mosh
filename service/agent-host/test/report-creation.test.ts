import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHostService } from "../src/service.js";
import { PlaytestStore } from "../src/persistence.js";

describe("report creation identity", () => {
  it("assigns one report id before normalizing evidence ids and persists the same identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mosh-report-"));
    const store = new PlaytestStore(root);
    const service = new AgentHostService(store);
    await service.initialize();
    const playtest = await service.createPlaytest({});

    const report = await service.createReport({
      playtestId: playtest.id,
      kind: "bug",
      title: "Unexpected loop",
      body: "The loop jumped at the boundary.",
      evidence: [{
        kind: "screenshot",
        localPath: "/tmp/window.png",
        sha256: "a".repeat(64),
        metadata: {
          buildSha: "abc123",
          dirtyDigest: "d".repeat(64),
          projectReference: "song.mosh",
          timelinePosition: 12.5,
          snapshotDigest: "e".repeat(64),
          recentResults: [{ command: "set_transport", ok: true }],
          width: 1440,
          height: 900,
        },
      }],
    });

    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.evidence[0]?.reportId).toBe(report.id);
    const persisted = JSON.parse(await readFile(
      path.join(root, "sessions", playtest.id, "reports", `${report.id}.json`),
      "utf8",
    )) as typeof report;
    expect(persisted.evidence[0]?.id).toBe(report.evidence[0]?.id);
    expect(persisted.evidence[0]?.reportId).toBe(persisted.id);
    expect(persisted.evidence[0]?.metadata).toEqual({
      buildSha: "abc123",
      dirtyDigest: "d".repeat(64),
      projectReference: "song.mosh",
      timelinePosition: 12.5,
      snapshotDigest: "e".repeat(64),
      recentResults: [{ command: "set_transport", ok: true }],
      width: 1440,
      height: 900,
    });
  });

  it("overrides caller-supplied report and evidence identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mosh-report-"));
    const service = new AgentHostService(new PlaytestStore(root));
    await service.initialize();
    const playtest = await service.createPlaytest({});

    const report = await service.createReport({
      id: "00000000-0000-4000-8000-000000000000",
      playtestId: playtest.id,
      kind: "note",
      title: "Small thought",
      body: "Try a quieter count-in.",
      evidence: [{
        id: "11111111-1111-4111-8111-111111111111",
        reportId: "22222222-2222-4222-8222-222222222222",
        playtestId: playtest.id,
        kind: "screenshot",
        localPath: "/tmp/window.png",
        sha256: "b".repeat(64),
        metadata: {},
        createdAt: new Date(0).toISOString(),
      }],
    });

    expect(report.id).not.toBe("00000000-0000-4000-8000-000000000000");
    expect(report.evidence[0]?.id).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(report.evidence[0]?.reportId).toBe(report.id);
    expect(report.evidence[0]?.playtestId).toBe(playtest.id);
  });
});
