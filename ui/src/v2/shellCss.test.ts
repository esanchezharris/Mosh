import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "shell.css"), "utf8");

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
