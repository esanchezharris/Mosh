import { describe, expect, it } from "vitest";
import { matchIssueReport } from "./issueRoute";

describe("deterministic issue route", () => {
  it("matches explicit typed and voice phrases", () => {
    expect(matchIssueReport("report a bug: single click adds a note"))
      .toEqual({ description: "single click adds a note", severity: "annoyance" });
    expect(matchIssueReport("log an issue I cannot record"))
      .toEqual({ description: "I cannot record", severity: "blocks music" });
    expect(matchIssueReport("please report an issue: the UI is stuck"))
      .toEqual({ description: "the UI is stuck", severity: "breaks flow" });
  });
  it("does not steal unrelated creative asks", () => {
    expect(matchIssueReport("fix the timing issues in this bass line")).toBeNull();
    expect(matchIssueReport("make this issue sound darker")).toBeNull();
  });
});
