import { describe, it, expect } from "vitest";
import { projectMemoryPath } from "./projectMemoryPath";

describe("projectMemoryPath", () => {
  it("appends .mosh-memory.json to a POSIX edit file path", () => {
    expect(projectMemoryPath("/Users/e/Music/lofi.mosh")).toBe("/Users/e/Music/lofi.mosh.mosh-memory.json");
  });

  it("appends .mosh-memory.json to a Windows backslash edit file path unchanged", () => {
    expect(projectMemoryPath("C:\\Users\\e\\Music\\lofi.mosh")).toBe("C:\\Users\\e\\Music\\lofi.mosh.mosh-memory.json");
  });

  it("returns empty string for an unsaved session (no edit file yet)", () => {
    expect(projectMemoryPath("")).toBe("");
    expect(projectMemoryPath("   ")).toBe("");
  });
});
