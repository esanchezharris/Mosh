// Guard: the warp "≈" clip badge (ClipView.tsx renders `span.v2-clip-badge.warp`)
// must be absolutely positioned like its styled badge siblings (.reimagine / .working),
// not left as a static inline span that overlaps the absolutely-positioned .v2-clip-label.
// Same readFileSync + content-assert pattern as ui/src/ui/Meter.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/v2/lanes
const css = readFileSync(join(here, "..", "shell.css"), "utf8");

describe(".v2-clip-badge.warp positioning", () => {
  // Isolate the `.v2-clip-badge.warp { ... }` rule body so the assertions
  // describe THIS badge, not a property that merely appears elsewhere in the file.
  const rule = css.match(/\.v2-clip-badge\.warp\s*\{([^}]*)\}/);

  it("declares an absolutely-positioned rule for the warp badge", () => {
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("position: absolute");
  });

  it("is non-interactive like its badge siblings (pointer-events: none)", () => {
    expect(rule![1]).toContain("pointer-events: none");
  });
});
