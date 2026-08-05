import { describe, it, expect } from "vitest";
import {
  FALLBACK_PROJECT_EXT,
  LEGACY_PROJECT_EXT,
  openProjectFilters,
  projectLabel,
  saveProjectDefaultName,
  saveProjectFilters,
} from "./projectFile";

// PRJ-NAME — project files are ".mosh" (was ".tracktionedit") and a new one is called
// "untitled - bearcat" (was "untitled-1722693847234"). These are the pure string rules
// behind both; TopBar, SessionPicker and the menu pickers all read them.

describe("projectLabel", () => {
  it("strips the directory and the extension", () => {
    expect(projectLabel("/Users/e/Library/Mosh/session/projects/my song.mosh")).toBe("my song");
  });

  it("handles a generated name's spaces and hyphen intact", () => {
    // The whole point of the rename: this has to read back exactly as generated.
    expect(projectLabel("/p/untitled - bearcat.mosh")).toBe("untitled - bearcat");
  });

  it("strips only the LAST extension, so a dotted project name survives", () => {
    expect(projectLabel("/p/mix v1.2.mosh")).toBe("mix v1.2");
  });

  it("still labels a legacy .tracktionedit project", () => {
    expect(projectLabel("/p/old song.tracktionedit")).toBe("old song");
  });

  it("returns empty for an empty path, leaving the fallback wording to the caller", () => {
    expect(projectLabel("")).toBe("");
  });
});

describe("picker filters", () => {
  it("open offers the current extension AND the legacy one", () => {
    const f = openProjectFilters("mosh");
    expect(f).toContain("*.mosh");
    // Back-compat is the requirement most likely to regress: projects saved before the
    // rename are never migrated, so filtering them out hides a producer's real work.
    expect(f).toContain("*.tracktionedit");
  });

  it("does not list the legacy extension twice when it IS the current one", () => {
    expect(openProjectFilters(LEGACY_PROJECT_EXT)).toBe("*.tracktionedit");
  });

  it("save offers the current extension only — never the legacy one", () => {
    expect(saveProjectFilters("mosh")).toBe("*.mosh");
    expect(saveProjectFilters("mosh")).not.toContain("tracktionedit");
  });
});

describe("saveProjectDefaultName", () => {
  it("pre-fills the open project's own stem with the current extension", () => {
    expect(saveProjectDefaultName("/p/untitled - bearcat.mosh", "mosh")).toBe("untitled - bearcat.mosh");
  });

  it("re-extensions a legacy project's stem to the current format", () => {
    expect(saveProjectDefaultName("/p/old song.tracktionedit", "mosh")).toBe("old song.mosh");
  });

  it("falls back to 'untitled' when there is no open project", () => {
    expect(saveProjectDefaultName("", "mosh")).toBe("untitled.mosh");
  });
});

it("the fallback extension is mosh and the legacy one is tracktionedit", () => {
  expect(FALLBACK_PROJECT_EXT).toBe("mosh");
  expect(LEGACY_PROJECT_EXT).toBe("tracktionedit");
});
