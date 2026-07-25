import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "shell.css"), "utf8");
// Structural assertions (does a SELECTOR exist / is it declared twice) must not read
// prose. The comments in shell.css deliberately quote the selectors they warn about.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("v2 shell.css .v2-btn disabled affordance", () => {
  it("ships a .v2-btn:disabled rule so disabled buttons read as non-interactive", () => {
    // .v2-btn renders disabled at real sites (LyricPanel/RhymeTool). Without this
    // rule a disabled button stayed full-opacity with a pointer cursor.
    expect(css).toContain(".v2-btn:disabled");
  });

  it("guards the hover-lift and active-scale with :not(:disabled)", () => {
    // A disabled button must not lift on hover or scale on press (it reads clickable).
    expect(css).toContain(".v2-btn:hover:not(:disabled)");
    expect(css).toContain(".v2-btn:active:not(:disabled)");
  });
});

describe("v2 shell.css floating-panel radius token", () => {
  it("uses --v2-radius for the composer panel (matches sibling floating panels)", () => {
    // The composer was the single remaining hardcoded `border-radius: 16px`; every
    // other floating panel references var(--v2-radius) (defined as 16px). Swapping to
    // the intended token is a visual no-op that keeps the radius scale single-sourced.
    const start = css.indexOf(".v2-composer {");
    const composerRule = css.slice(start, css.indexOf("}", start) + 1);
    expect(composerRule).toContain("border-radius: var(--v2-radius);");
    expect(composerRule).not.toContain("border-radius: 16px");
  });

  it("no longer hardcodes `border-radius: 16px` anywhere in the shell", () => {
    expect(css).not.toContain("border-radius: 16px");
  });
});

describe("v2 shell.css transport-clock font-size token", () => {
  it("routes the .v2-time BBS clock through --v2-fs-xl (the sole 20px readout)", () => {
    // .v2-time was the single remaining `font-size: 20px` literal, and it's the exact
    // value of --v2-fs-xl (20px). Swapping to the intended token is a visual no-op that
    // single-sources the largest chrome readout size.
    const start = css.indexOf(".v2-time {");
    const timeRule = css.slice(start, css.indexOf("}", start) + 1);
    expect(timeRule).toContain("font-size: var(--v2-fs-xl)");
    expect(timeRule).not.toContain("font-size: 20px");
  });

  it("no longer hardcodes `font-size: 20px` anywhere in the shell", () => {
    expect(css).not.toContain("font-size: 20px");
  });
});

describe("v2 shell.css single-owner class rules", () => {
  // Two rule blocks sharing one bare class name is how the per-track peak meter broke:
  // `.v2-meter` was declared for the track-header meter AND again for PresenceMeter's
  // level bars, and the second block's DESCENDANT rule (`.v2-meter span`) reached the
  // `.mbar` spans inside TrackMeterBar and froze them at `transform: scaleY(0.18)`. The
  // cascade made that invisible to review and jsdom made it invisible to the unit suite.
  // A class that needs a second block is a class that needs a second NAME.
  const headers = [...cssCode.matchAll(/^\.([a-zA-Z0-9_-]+) \{/gm)].map((m) => m[1]);

  it("parses a plausible number of top-level rules (anti-vacuity)", () => {
    // A parser that silently matched nothing would make every assertion below pass.
    expect(headers.length).toBeGreaterThan(200);
  });

  it("declares each bare class name in exactly one rule block", () => {
    const seen = new Map<string, number>();
    for (const h of headers) seen.set(h, (seen.get(h) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    expect(duplicated).toEqual([]);
  });
});

describe("v2 shell.css meter separation", () => {
  it("scopes PresenceMeter's bars so they cannot reach the track meter's .mbar spans", () => {
    // The descendant selector must be anchored to the presence card, not left bare.
    expect(cssCode).toContain(".v2-pcard-meta .v2-pcard-level span");
    expect(cssCode).not.toContain(".v2-meter span");
  });

  it("repaints the track meter's unlit mask to the v2 header ground", () => {
    // mosh.css paints .mmask with --ink-deep (the CLASSIC ground, cream in light theme).
    // v2 headers stay dark in both themes, so the mask has to be re-pointed or it
    // highlights the unlit portion instead of hiding it.
    expect(cssCode).toContain(".v2-shell .v2-meter .mmask { background: var(--v2-ink); }");
  });

  it("masks with a token that is opaque in BOTH themes", () => {
    // The mask OVERLAYS the level gradient, so a translucent value lets it ghost through.
    // --v2-surface / --v2-surface-2 are deliberately rgba() in the dark theme, which is
    // why the mask uses --v2-ink: it must be declared as a hex in every theme block.
    const decls = [...cssCode.matchAll(/--v2-ink:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length, "expected --v2-ink in the base and light blocks").toBe(2);
    for (const v of decls) expect(v, `--v2-ink is not opaque: ${v}`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });
});

describe("v2 shell.css uppercase caps-label tracking token", () => {
  it("routes every caps label through --v2-tracking-caps (no hardcoded 0.14em)", () => {
    // --v2-tracking-caps (0.14em) names "the recurring uppercase-label treatment"; the
    // three uppercase caps labels (.pg-label / .v2-pb-listhead / .v2-pb-group) used to
    // hardcode `letter-spacing: 0.14em`. Routing them through the token is a visual
    // no-op that single-sources the caps tracking. (The token DEFINITION still carries
    // the 0.14em value — only the `letter-spacing: 0.14em` literal is banned.)
    expect(css).not.toContain("letter-spacing: 0.14em");
    expect(css).toContain("letter-spacing: var(--v2-tracking-caps)");
  });
});
