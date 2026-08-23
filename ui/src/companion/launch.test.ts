import { describe, expect, it } from "vitest";
import { consumeLaunch } from "./launch";

describe("consumeLaunch", () => {
  it("selects Ableton mode from the fragment token and clears the visible URL", () => {
    // Given
    const cleared: string[] = [];

    // When
    const launch = consumeLaunch("http://studio.local:8123/web#token=per-launch-secret", (url) => cleared.push(url));

    // Then
    expect(launch).toEqual({ kind: "ableton", token: "per-launch-secret" });
    expect(cleared).toEqual(["/web"]);
  });

  it("keeps the existing Mosh query-token launch behavior", () => {
    // Given
    const cleared: string[] = [];

    // When
    const launch = consumeLaunch("http://studio.local/web?token=mosh-token", (url) => cleared.push(url));

    // Then
    expect(launch).toEqual({ kind: "mosh", pairing: { token: "mosh-token" } });
    expect(cleared).toEqual([]);
  });

  it("rejects an empty Ableton fragment token", () => {
    // Given
    const href = "http://studio.local/web#token=";

    // When / Then
    expect(() => consumeLaunch(href, () => undefined)).toThrow();
  });
});
