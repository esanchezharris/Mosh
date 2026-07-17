import { describe, it, expect, beforeEach } from "vitest";
import { loadMpIdentity, saveMpIdentity } from "./identity";

const KEY = "mosh.mp.identity";

describe("multiplayer identity persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("first run (no persisted identity) never returns a blank name", () => {
    const id = loadMpIdentity();
    expect(id.name.trim().length).toBeGreaterThan(0);
    expect(id.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("round-trips a saved identity", () => {
    saveMpIdentity({ name: "Ada", color: "#3aa0ff" });
    const id = loadMpIdentity();
    expect(id).toEqual({ name: "Ada", color: "#3aa0ff" });
  });

  it("falls back to a non-empty default name if the persisted name is blank/whitespace", () => {
    localStorage.setItem(KEY, JSON.stringify({ name: "   ", color: "#e0457b" }));
    const id = loadMpIdentity();
    expect(id.name).toBe("Producer");
    expect(id.color).toBe("#e0457b");
  });

  it("degrades an invalid color to a valid default instead of persisting garbage", () => {
    localStorage.setItem(KEY, JSON.stringify({ name: "Bo", color: "not-a-color" }));
    const id = loadMpIdentity();
    expect(id.name).toBe("Bo");
    expect(id.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("a corrupt persisted blob degrades to full defaults rather than throwing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(() => loadMpIdentity()).not.toThrow();
    const id = loadMpIdentity();
    expect(id.name).toBe("Producer");
  });
});
