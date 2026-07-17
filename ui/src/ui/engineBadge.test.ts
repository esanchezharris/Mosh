import { describe, it, expect } from "vitest";
import { resolveSa3Available, engineBadgeView, renderedByLabel } from "./engineBadge";

describe("resolveSa3Available", () => {
  it("trusts an explicit true from /colors", () => {
    expect(resolveSa3Available(true, 0)).toBe(true);
  });

  it("trusts an explicit false from /colors even with a non-empty colour rack", () => {
    // the exact bug this fixes: FakeAdapter still returns colours, so the old
    // colorsAvail.length > 0 proxy would have lied here.
    expect(resolveSa3Available(false, 9)).toBe(false);
  });

  it("falls back to the colour-rack proxy when sa3Available is undefined (old service)", () => {
    expect(resolveSa3Available(undefined, 3)).toBe(true);
    expect(resolveSa3Available(undefined, 0)).toBe(false);
  });
});

describe("engineBadgeView", () => {
  it("labels the real model SA3 with a confirming tooltip", () => {
    const v = engineBadgeView(true);
    expect(v.label).toBe("SA3");
    expect(v.title).toMatch(/real Stable Audio 3/);
  });

  it("labels the fake engine 'preview' with a setup-pointer tooltip", () => {
    const v = engineBadgeView(false);
    expect(v.label).toBe("preview");
    expect(v.title).toMatch(/setup-guest\.sh/);
  });
});

describe("renderedByLabel", () => {
  it("surfaces a callout when the render actually came from the fake adapter", () => {
    expect(renderedByLabel("fake")).toBe("rendered by preview engine");
  });

  it("stays silent for the real model (the expected, unsurprising case)", () => {
    expect(renderedByLabel("stable_audio3")).toBeNull();
  });

  it("stays silent for other real adapters (transform/soulx) and missing/undefined", () => {
    expect(renderedByLabel("transform")).toBeNull();
    expect(renderedByLabel("soulx")).toBeNull();
    expect(renderedByLabel(undefined)).toBeNull();
    expect(renderedByLabel(null)).toBeNull();
  });
});
