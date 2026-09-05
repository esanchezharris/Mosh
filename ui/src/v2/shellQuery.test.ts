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

  it("keeps the Live query override when Pro Tools is the persisted or default shell", () => {
    window.history.replaceState({}, "", "/?shell=live");
    expect(devShellOverride()).toBe("live");
    expect(resolveShell("protools")).toBe("live");
  });

  it("resolves the additive v3 shell from setting and query", () => {
    expect(resolveShell("v3")).toBe("v3");
    window.history.replaceState({}, "", "/?shell=v3");
    expect(devShellOverride()).toBe("v3");
    expect(resolveShell("protools")).toBe("v3");
  });
});
