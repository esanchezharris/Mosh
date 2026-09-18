import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { V3_COLORWAYS, colorwayAttr } from "./colorway";

// V3 parity brief row 13 — every accent in the V3 stylesheet derives from --accent, so the
// four colorways tint selection, chips, kept takes and the listening ring their own way.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "shell.css"), "utf8");
const tokens = readFileSync(resolve(here, "tokens.css"), "utf8");

describe("V3 colorway tokens", () => {
  it("shell.css carries no fixed lime (rgba or hex) outside the token file", () => {
    expect(css).not.toMatch(/198,\s*245,\s*66/);
    expect(css).not.toMatch(/#c6f542/i);
    expect(css).not.toMatch(/#263018|#1C2414|#262C1C/i);
  });
  it("the token file still defines lime as one of four accents (anti-vacuity: the literal lives exactly there)", () => {
    expect(tokens).toMatch(/--accent:\s*#C6F542/i);
    for (const c of V3_COLORWAYS) expect(tokens).toMatch(new RegExp(`data-colorway="${c}"`));
    expect(V3_COLORWAYS).toHaveLength(4);
    expect(colorwayAttr("nope")).toBe("lime");
  });
  it("accent-derived rules use color-mix on --accent (a count floor so a rewrite cannot silently drop them)", () => {
    expect((css.match(/color-mix\(in srgb, var\(--accent\)/g) ?? []).length).toBeGreaterThanOrEqual(12);
  });
});
