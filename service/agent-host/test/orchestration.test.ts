import { describe, expect, it } from "vitest";
import { startAgentHost } from "../src/server.js";
import { orchestrationFixture } from "./orchestration-fixture.js";

describe("owner orchestration approval and coordinator", () => {
  it("performs no external write before approval, then uploads immutable PNG evidence and syncs one issue", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    expect(fakes.evidenceCalls).toEqual([]);
    expect(fakes.githubCalls).toEqual([]);

    const approved = await service.approveReport(report.id);

    expect(approved.status).toBe("approved");
    expect(fakes.evidenceCalls).toHaveLength(1);
    expect(fakes.githubCalls).toHaveLength(1);
    expect(fakes.evidenceCalls[0]).not.toContain("owner-secret");
  });

  it("refuses an uploaded checksum that differs from the durable local screenshot", async () => {
    const { fakes, service, report } = await orchestrationFixture();
    fakes.evidenceSha = "b".repeat(64);
    await expect(service.approveReport(report.id)).rejects.toMatchObject({
      code: "evidence_checksum_mismatch",
    });
    expect(fakes.githubCalls).toEqual([]);
  });

  it("keeps missing gh authentication pending and retries idempotently through the same report identity", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    fakes.authenticated = false;
    expect((await service.approveReport(report.id)).status).toBe("approved_pending_sync");
    fakes.authenticated = true;
    expect((await service.approveReport(report.id)).status).toBe("approved");
    const calls = fakes.githubCalls.map((call) =>
      (JSON.parse(call) as { reportId: string }).reportId);
    expect(calls).toEqual([report.id, report.id]);
    expect((await store.loadReport(report.id)).external?.issueNumber).toBe(42);
  });

  it("persists the stable sync intent before an ambiguous GitHub result", async () => {
    const { fakes, service, store, report } = await orchestrationFixture();
    fakes.githubTransportFailure = true;
    await expect(service.approveReport(report.id)).rejects.toMatchObject({ code: "github_failed" });
    expect(await store.loadReport(report.id)).toMatchObject({
      syncIntent: {
        marker: `mosh-playtest-report:${report.id}`,
        state: "pending",
      },
    });
  });

  it("creates one scrubbed read-only coordinator thread per playtest and records streamed events", async () => {
    const { fakes, service, store, playtest, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    await service.coordinateReport(report.id);
    await service.coordinateReport(report.id);

    const threads = fakes.appCalls.filter((call) => call.kind === "thread");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.value).toMatchObject({ mode: "read-only", cwd: "/repo" });
    const serialized = JSON.stringify(fakes.appCalls);
    expect(serialized).toContain("Loop jumps");
    expect(serialized).not.toContain("must-not-leave-host");
    expect((await store.loadEvents(playtest.id)).map((event) => event.type))
      .toContain("codex.turn.started");
  });

  it("serializes concurrent coordinator creation and fails closed on a stranded reservation", async () => {
    const { fakes, service, store, playtest, report } = await orchestrationFixture();
    await service.approveReport(report.id);
    const session = await store.loadSession(playtest.id);
    const unreserved = { ...session };
    delete unreserved.coordinatorThreadId;
    delete unreserved.coordinator;
    await store.saveSession({ ...unreserved, updatedAt: new Date().toISOString() });
    fakes.appCalls.length = 0;

    await Promise.all([
      service.coordinateReport(report.id),
      service.coordinateReport(report.id),
    ]);
    expect(fakes.appCalls.filter((call) => call.kind === "thread")).toHaveLength(1);

    const ready = await store.loadSession(playtest.id);
    const stranded = {
      ...ready,
      coordinator: { state: "starting", reservationId: crypto.randomUUID() },
      updatedAt: new Date().toISOString(),
    } as const;
    delete (stranded as { coordinatorThreadId?: string }).coordinatorThreadId;
    await store.saveSession(stranded);
    const before = fakes.appCalls.length;
    await expect(service.coordinateReport(report.id)).rejects.toMatchObject({
      code: "coordinator_recovery_required",
    });
    expect(fakes.appCalls).toHaveLength(before);
  });

  it("rejects nested result payloads before sending any report context to app-server", async () => {
    const { fakes, orchestration, report } = await orchestrationFixture();
    const unsafe = structuredClone(report);
    const evidence = unsafe.evidence[0];
    if (!evidence) throw new Error("Fixture evidence is missing");
    evidence.metadata.recentResults = [{
      command: "set_loop",
      ok: false,
      payload: { audio: "data:audio/wav;base64,AAAA" },
    }];
    await expect(orchestration.coordinateReport(unsafe)).rejects.toThrow();
    expect(fakes.appCalls).toEqual([]);
  });
});

describe("authenticated orchestration routes", () => {
  it("rejects unauthenticated Fix Now and admits the approved authenticated request", async () => {
    const { service, report } = await orchestrationFixture();
    const host = await startAgentHost({ service, capability: "task4-capability" });
    try {
      const unauthenticated = await fetch(`${host.origin}/v1/reports/${report.id}/repairs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(unauthenticated.status).toBe(401);
      const approved = await fetch(`${host.origin}/v1/reports/${report.id}/approve`, {
        method: "POST",
        headers: {
          Authorization: "Bearer task4-capability",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(approved.status).toBe(200);
      const repair = await fetch(`${host.origin}/v1/reports/${report.id}/repairs`, {
        method: "POST",
        headers: {
          Authorization: "Bearer task4-capability",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(repair.status).toBe(201);
      expect(await repair.json()).toMatchObject({ status: "running", reportId: report.id });
    } finally {
      await host.close();
    }
  });
});
