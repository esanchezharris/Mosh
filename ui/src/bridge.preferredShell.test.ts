import { describe, expect, it } from "vitest";
import { parseBrainRuntimeStatus } from "./bridge";

// The owner runtime may hand the UI a preferred shell (App.tsx applies it to `uiShell`).
// Every selectable shell must round-trip; anything else is dropped, never passed through.
describe("parseBrainRuntimeStatus preferredShell", () => {
  it("round-trips every selectable shell, including v3", () => {
    for (const shell of ["classic", "v2", "live", "protools", "v3"] as const)
      expect(parseBrainRuntimeStatus({ state: "ready", preferredShell: shell }).preferredShell).toBe(shell);
  });

  it("drops an unknown or non-string value (anti-vacuity for the whitelist)", () => {
    expect(parseBrainRuntimeStatus({ state: "ready", preferredShell: "bogus" }).preferredShell).toBeUndefined();
    expect(parseBrainRuntimeStatus({ state: "ready", preferredShell: 3 }).preferredShell).toBeUndefined();
    expect(parseBrainRuntimeStatus({ state: "ready" }).preferredShell).toBeUndefined();
  });
});
