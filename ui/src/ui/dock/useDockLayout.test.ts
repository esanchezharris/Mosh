import { describe, it, expect } from "vitest";
import { parseDock, useDockLayout } from "./useDockLayout";

describe("applyPreset (template dock restructure)", () => {
  it("collapsing via a preset stashes the live width so the next expand restores it", () => {
    const st = useDockLayout.getState();
    // Open the browser at a known width (an explicit preset size).
    st.applyPreset({ left: { collapsed: false, size: 300 } });
    expect(useDockLayout.getState().left).toMatchObject({ collapsed: false, size: 300 });
    // Collapse via a preset (like switching to the Mosh template).
    st.applyPreset({ left: { collapsed: true } });
    expect(useDockLayout.getState().left.collapsed).toBe(true);
    // Re-expand → restores 300 (the last shown width), NOT the default 240.
    st.toggleLeft();
    expect(useDockLayout.getState().left).toMatchObject({ collapsed: false, size: 300 });
  });

  it("clamps an out-of-range preset size to the zone's [min,max]", () => {
    useDockLayout.getState().applyPreset({ left: { collapsed: false, size: 9999 } });
    const z = useDockLayout.getState().left;
    expect(z.size).toBeLessThanOrEqual(z.max);
    expect(z.size).toBeGreaterThanOrEqual(z.min);
  });
});

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
