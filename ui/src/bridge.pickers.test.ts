import { describe, expect, it } from "vitest";
import { isRealNative, pickFiles, pickSaveFile } from "./bridge";

describe("browser mock file pickers", () => {
  it("returns deterministic project and export destinations without invoking JUCE", async () => {
    expect(isRealNative()).toBe(false);

    await expect(pickFiles({ title: "Open project", filters: "*.mosh" })).resolves.toEqual({
      ok: true,
      files: ["/mock/sessions/protools-tonight.mosh"],
    });
    await expect(pickSaveFile({ title: "Save project as", defaultName: "untitled.mosh" })).resolves.toEqual({
      ok: true,
      file: "/mock/sessions/protools-tonight.mosh",
    });
    await expect(pickSaveFile({ title: "Export audio", defaultName: "mix.wav" })).resolves.toEqual({
      ok: true,
      file: "/mock/exports/mix.wav",
    });
  });
});
