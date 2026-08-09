import { afterEach, describe, expect, it } from "vitest";
import { devShellOverride, resolveShell } from "./shellQuery";

describe("Pro Tools shell routing", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("keeps an explicit Pro Tools setting instead of falling back to Classic", () => {
    expect(resolveShell("protools")).toBe("protools");
  });

  it("loads Pro Tools from the dev-only shell query without changing persistence", () => {
    window.history.replaceState({}, "", "/?shell=protools");
    expect(devShellOverride()).toBe("protools");
    expect(resolveShell("live")).toBe("protools");
  });
});
