import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { V3_COLORWAYS, colorwayAttr } from "./colorway";

// V3 parity brief row 13 — every accent in the V3 stylesheet derives from --accent, so the
// four colorways tint selection, chips, kept takes and the listening ring their own way.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "shell.css"), "utf8");
// The plugin panels' stylesheets (imported by shell.css through panels/css/index.css) obey
// the same rule: tokens only, never a fixed colour.
const panelCssDir = resolve(here, "panels/css");
const panelCss = readdirSync(panelCssDir).filter((f) => f.endsWith(".css"))
  .map((f) => ({ f, text: readFileSync(resolve(panelCssDir, f), "utf8") }));
const tokens = readFileSync(resolve(here, "tokens.css"), "utf8");

describe("V3 colorway tokens", () => {
  it("shell.css carries no fixed lime (rgba or hex) outside the token file", () => {
    expect(css).not.toMatch(/198,\s*245,\s*66/);
    expect(css).not.toMatch(/#c6f542/i);
    expect(css).not.toMatch(/#263018|#1C2414|#262C1C/i);
  });
  it("the plugin panel stylesheets use tokens only: no hex, rgb() or hsl() colour literals", () => {
    expect(panelCss.length).toBeGreaterThan(0);   // anti-vacuity: index.css at least
    for (const { f, text } of panelCss) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, f).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(code, f).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/i);
    }
  });
  it("every panel stylesheet in panels/css is imported by panels/css/index.css (a forgotten import ships unstyled)", () => {
    const index = panelCss.find((x) => x.f === "index.css")?.text ?? "";
    for (const { f } of panelCss) if (f !== "index.css") expect(index, f).toContain(`@import "./${f}"`);
  });
  it("the token file still defines lime as one of four accents (anti-vacuity: the literal lives exactly there)", () => {
    expect(tokens).toMatch(/--accent:\s*#C6F542/i);
    for (const c of V3_COLORWAYS) expect(tokens).toMatch(new RegExp(`data-colorway="${c}"`));
    expect(V3_COLORWAYS).toHaveLength(4);
    expect(colorwayAttr("nope")).toBe("lime");
  });
  it("every range input in the shell follows --accent (the Sends sliders once rendered the browser's blue)", () => {
    expect(css).toMatch(/\.v3-shell input\[type="range"\]\s*\{[^}]*accent-color:\s*var\(--accent\)/);
  });
  it("accent-derived rules use color-mix on --accent (a count floor so a rewrite cannot silently drop them)", () => {
    expect((css.match(/color-mix\(in srgb, var\(--accent\)/g) ?? []).length).toBeGreaterThanOrEqual(12);
  });
});
