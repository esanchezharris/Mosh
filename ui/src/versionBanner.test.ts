import { describe, it, expect } from "vitest";
import { versionBannerError, EXPECTED_SNAPSHOT_SCHEMA } from "./types";

// PRJ-FMT — the cold-start file-format refusal + snapshot wire-contract guard banners.
describe("versionBannerError", () => {
  it("returns null when the project loaded fine and schema matches", () => {
    expect(versionBannerError({ schemaVersion: EXPECTED_SNAPSHOT_SCHEMA, session: {} })).toBeNull();
  });

  it("surfaces a cold-start file-format refusal verbatim (blocking)", () => {
    const msg = "This project (format v2) was made by a newer version of Mosh than this build (v1). Please update Mosh to open it.";
    expect(versionBannerError({ schemaVersion: EXPECTED_SNAPSHOT_SCHEMA, session: { loadError: msg } })).toBe(msg);
  });

  it("surfaces a soft 'app older than engine' advisory on a higher snapshot schema", () => {
    expect(versionBannerError({ schemaVersion: EXPECTED_SNAPSHOT_SCHEMA + 1, session: {} }))
      .toMatch(/older than its engine/i);
  });

  it("prefers the file-format refusal over the schema advisory when both apply", () => {
    const msg = "newer version of Mosh";
    expect(versionBannerError({ schemaVersion: EXPECTED_SNAPSHOT_SCHEMA + 1, session: { loadError: msg } })).toBe(msg);
  });

  it("does not warn when the UI is NEWER than the engine (lower reported schema)", () => {
    expect(versionBannerError({ schemaVersion: EXPECTED_SNAPSHOT_SCHEMA - 1, session: {} })).toBeNull();
  });
});
