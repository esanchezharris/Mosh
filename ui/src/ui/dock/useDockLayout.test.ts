import { describe, it, expect } from "vitest";
import { parseDock } from "./useDockLayout";

describe("parseDock", () => {
  it("defaults all three zones when storage is null (Session rail open by default)", () => {
    const d = parseDock(null);
    expect(d.right).toMatchObject({ id: "inspector", collapsed: false });
    expect(d.left.id).toBe("browser");
    expect(d.bottom.id).toBe("detail");
  });
  it("reads a stored, pinned-open right zone", () => {
    const d = parseDock({ bottom: { size: 200 }, left: { size: 240 }, right: { size: 320, collapsed: false } });
    expect(d.right.size).toBe(320);
    expect(d.right.collapsed).toBe(false);
  });
  it("migrates the old { bottom, left } shape by defaulting the right zone", () => {
    const d = parseDock({ bottom: { size: 200 }, left: { size: 240, collapsed: true } });
    expect(d.right).toMatchObject({ id: "inspector", collapsed: false });
  });
});
