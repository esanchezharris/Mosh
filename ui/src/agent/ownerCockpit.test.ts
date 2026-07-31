import { describe, expect, it, vi } from "vitest";
import {
  ReportApprovalInbox,
  classifyReportTrigger,
  type DraftReportInput,
} from "./ownerCockpit";

describe("owner cockpit report triggers", () => {
  it.each([
    ["log this: the count-in skipped", "note"],
    ["there is a bug in take lanes", "bug"],
    ["blocker — playback is silent", "blocker"],
    ["note: the label is cramped", "note"],
    ["BUG", "bug"],
  ] as const)("matches explicit whole phrases in %j", (text, kind) => {
    expect(classifyReportTrigger(text)).toBe(kind);
  });

  it.each([
    "debug the take lane",
    "the notebook is open",
    "unblocker styling",
    "catalog this",
    "noteworthy timing",
  ])("does not match a substring in %j", (text) => {
    expect(classifyReportTrigger(text)).toBeNull();
  });
});

describe("owner cockpit report persistence", () => {
  const draft: DraftReportInput = {
    kind: "bug",
    title: "Loop jumped",
    body: "The loop jumped at the boundary.",
  };

  it("adds an approval item only after the native host has durably returned it", async () => {
    const order: string[] = [];
    let finish!: (value: { id: string; kind: "bug"; title: string; body: string; status: "draft" }) => void;
    const persisted = new Promise<{ id: string; kind: "bug"; title: string; body: string; status: "draft" }>((resolve) => { finish = resolve; });
    const inbox = new ReportApprovalInbox({
      createReport: vi.fn(async () => {
        order.push("persist-start");
        const report = await persisted;
        order.push("persist-done");
        return report;
      }),
      approveReport: vi.fn(),
    }, (items) => order.push(`render-${items.length}`));

    const pending = inbox.create(draft);
    expect(inbox.items).toEqual([]);
    finish({ id: "report-1", kind: "bug", title: draft.title, body: draft.body, status: "draft" });
    await pending;

    expect(order).toEqual(["persist-start", "persist-done", "render-1"]);
    expect(inbox.items[0]?.id).toBe("report-1");
  });

  it("keeps the inbox empty when durable creation fails", async () => {
    const inbox = new ReportApprovalInbox({
      createReport: vi.fn(async () => { throw new Error("host outage"); }),
      approveReport: vi.fn(),
    });
    await expect(inbox.create(draft)).rejects.toThrow("host outage");
    expect(inbox.items).toEqual([]);
  });
});
