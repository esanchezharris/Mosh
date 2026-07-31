import { describe, expect, it } from "vitest";
import { readShellCss } from "../cssSource";

const css = readShellCss();
const drawerRule = css.match(/\.v2-agent-drawer\s*\{([^}]*)\}/);
const entranceFrames = css.match(/@keyframes v2AgentDrawerIn\s*\{([^}]*(?:\}[^}]*)?)\}/);

describe("AgentDrawer pixel visibility", () => {
  it("is opaque as soon as its accessibility subtree mounts", () => {
    expect(drawerRule).not.toBeNull();
    expect(drawerRule![1]).toContain("opacity: 1");
  });

  it("does not animate from a fully transparent frame", () => {
    expect(entranceFrames).not.toBeNull();
    expect(entranceFrames![1]).not.toContain("opacity: 0");
  });
});
