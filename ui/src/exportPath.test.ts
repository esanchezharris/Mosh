import { describe, expect, it } from "vitest";
import { parentDir } from "./exportPath";

describe("parentDir", () => {
  it("strips the filename from an absolute path", () => {
    expect(parentDir("/Users/x/Library/Mosh/session/exports/mix-1.wav"))
      .toBe("/Users/x/Library/Mosh/session/exports");
  });
  it("returns '/' for a top-level file", () => {
    expect(parentDir("/mix.wav")).toBe("/");
  });
  it("returns '' for a bare filename (no directory component)", () => {
    expect(parentDir("mix.wav")).toBe("");
  });
  it("returns '' for an empty string", () => {
    expect(parentDir("")).toBe("");
  });
  it("strips the filename from a Windows backslash path (juce::File on the Windows target)", () => {
    expect(parentDir("C:\\Users\\x\\AppData\\Local\\Mosh\\session\\exports\\mix-1.wav"))
      .toBe("C:\\Users\\x\\AppData\\Local\\Mosh\\session\\exports");
  });
});
