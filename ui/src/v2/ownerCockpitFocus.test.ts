import { describe, expect, it } from "vitest";
import { readShellCss } from "./cssSource";

const cssCode = readShellCss().replace(/\/\*[\s\S]*?\*\//g, "");

describe("owner cockpit keyboard focus", () => {
  it("renders an explicit visible focus ring for every cockpit button and checkbox", () => {
    const buttonStart = cssCode.indexOf(".v2-owner-cockpit button:focus-visible");
    const buttonRule = cssCode.slice(buttonStart, cssCode.indexOf("}", buttonStart) + 1);
    const checkboxStart = cssCode.indexOf(".v2-owner-cockpit input[type=\"checkbox\"]:focus-visible");
    const checkboxRule = cssCode.slice(checkboxStart, cssCode.indexOf("}", checkboxStart) + 1);

    expect(buttonStart).toBeGreaterThanOrEqual(0);
    expect(buttonRule).toContain("outline:");
    expect(buttonRule).toContain("var(--v2-accent)");
    expect(checkboxStart).toBeGreaterThanOrEqual(0);
    expect(checkboxRule).toContain("outline:");
    expect(checkboxRule).toContain("var(--v2-accent)");
  });
});
