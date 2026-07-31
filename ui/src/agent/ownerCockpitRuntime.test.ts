import { describe, expect, it, vi } from "vitest";
import { OwnerCockpitRuntime } from "./ownerCockpitRuntime";
import type { DraftReportInput } from "./ownerCockpit";

function runtime() {
  let report = 0;
  const client = {
    start: vi.fn(async (retainTranscript: boolean) => ({
      active: true,
      retainTranscript,
      disclosureRequired: true,
    })),
    close: vi.fn(async (retainTranscript: boolean) => ({ active: false, retainTranscript })),
    watchEvents: vi.fn(() => () => undefined),
    realtimeSecret: vi.fn(async () => "ek_test"),
    createReport: vi.fn(async (input: DraftReportInput) => ({
      id: `report-${++report}`,
      ...input,
      status: "draft" as const,
    })),
    approveReport: vi.fn(async () => undefined),
  };
  return new OwnerCockpitRuntime(client);
}

describe("owner cockpit runtime presentation", () => {
  it("shows the hosted-trace disclosure only when the host marks this session", async () => {
    const cockpit = runtime();
    await cockpit.start(true);
    expect(cockpit.getSnapshot()).toMatchObject({
      status: "active",
      retainTranscript: true,
      disclosure: expect.stringContaining("Audio, screenshots, media, credentials, and project files are excluded."),
    });
  });

  it("holds minor notes until pause/close flush while surfacing blockers immediately", async () => {
    const cockpit = runtime();
    await cockpit.createReport({ kind: "note", title: "Small spacing", body: "note spacing" });
    expect(cockpit.getSnapshot()).toMatchObject({ reports: [], pendingNotes: 1, urgentMessage: null });

    cockpit.flushQuietReports();
    expect(cockpit.getSnapshot()).toMatchObject({
      reports: [expect.objectContaining({ kind: "note" })],
      pendingNotes: 0,
    });

    await cockpit.createReport({ kind: "blocker", title: "No playback", body: "blocker silence" });
    expect(cockpit.getSnapshot()).toMatchObject({
      urgentMessage: "Blocker captured: No playback",
      reports: [
        expect.objectContaining({ kind: "note" }),
        expect.objectContaining({ kind: "blocker" }),
      ],
    });
  });
});
