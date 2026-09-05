import { describe, expect, it } from "vitest";
import { colorwayAttr } from "./colorway";

describe("colorwayAttr", () => {
  it("keeps the four locked colorways and defaults unknown values to lime", () => {
    expect(colorwayAttr("lime")).toBe("lime");
    expect(colorwayAttr("bone")).toBe("bone");
    expect(colorwayAttr("violet")).toBe("violet");
    expect(colorwayAttr("coral")).toBe("coral");
    expect(colorwayAttr("neon")).toBe("lime");
    expect(colorwayAttr(undefined)).toBe("lime");
  });
});
