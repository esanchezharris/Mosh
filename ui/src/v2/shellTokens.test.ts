import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// PR-2.6 — the type and radius scales were DEFINED in shell.css but essentially unadopted
// (`var(--v2-fs-` appeared once; `var(--v2-space-` zero times). 129 declarations matched a
// scale step exactly and now go through the token.
//
// This is the STANDING guard. The one-shot proof that the substitution changed nothing was
// a resolved-stylesheet diff (expand every var() on both sides, compare) — deliberately not
// committed as a snapshot, because a 1500-line resolved blob gets `-u`'d blindly and is
// vacuous within two PRs. What's worth keeping is a ratchet: every remaining off-scale
// value is listed with a reason, and the list may only shrink.
//
// Spacing (gap/padding/margin) is deliberately NOT covered. Spacing is not a theme axis, so
// tokens buy nothing a literal doesn't; `padding: 6px 9px` reads worse tokenized; and the
// visual harness covers few of those sites. It was measured at ~192 declarations and
// dropped as net-negative.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "shell.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Values that legitimately sit outside the scale, each with why. Shrink-only. */
const DOCUMENTED_LITERALS: Record<string, Record<string, string>> = {
  "font-size": {
    // `font-size: 0` is gone: its only users were the `.v2-topbar .v2-tools .*-pop > .btn`
    // glyph-hiding rules, which went dead when the tools moved into the overflow menu (they
    // pass real icon components as labels now, so there is no text to hide).
    "12px": "the single biggest de-facto size in the shell; between --v2-fs-sm (11) and --v2-fs-base (13). Adding a scale step for it is a design decision, not a normalisation",
    "12.5px": "one deliberate optical nudge; rounding it is a visual change, not a no-op",
    "14px": "between --v2-fs-base (13) and --v2-fs-md (15); same call as 12px",
    "16px": "between --v2-fs-md (15) and --v2-fs-lg (17); same call as 12px",
    "30px": "the presence-card avatar initial — a one-off display size, not chrome",
  },
  "border-radius": {
    "0": "a reset (square corner), not a radius on the scale",
    "50%": "a circle. Semantically different from any px radius and must not be rounded to one",
    "1px": "a hairline bar cap; a scale step would visibly round it",
    "3px": "small inline chips/caps below --v2-radius-xs (4px)",
    // The 5/6/7/9/11/14 cluster is the shell's de-facto radius vocabulary. Rounding any
    // of them to a scale step is a REAL 1-2px visual change, not a normalisation, so it
    // cannot ride the value-preserving substitution — it needs its own reviewed pass with
    // image diffs. Documented here so the debt is visible and bounded rather than silent.
    "5px": "de-facto radius; snapping to 4px is a visible 1px change, not a no-op substitution",
    "6px": "de-facto radius; sits between --v2-radius-xs (4px) and --v2-radius-md (8px)",
    "7px": "de-facto radius; rounding to 8px would visibly soften small controls",
    "9px": "de-facto radius, the most common off-scale one; between --v2-radius-md and -sm",
    "11px": "de-facto radius; between --v2-radius-sm (10px) and --v2-radius-lg (12px)",
    "14px": "de-facto radius; between --v2-radius-lg (12px) and --v2-radius (16px)",
  },
};

/** Ceilings on how many off-scale declarations may remain. May only go DOWN. */
const CEILING: Record<string, number> = { "font-size": 33, "border-radius": 34 };

function declarations(prop: string): { value: string; tokenized: boolean }[] {
  const out: { value: string; tokenized: boolean }[] = [];
  for (const m of css.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;{}]+);`, "g"))) {
    const v = m[1].trim();
    out.push({ value: v, tokenized: v.startsWith("var(") });
  }
  return out;
}

describe("v2 shell.css scale adoption", () => {
  it("parses a plausible number of declarations (anti-vacuity)", () => {
    // Every assertion below is "nothing unexpected found"; a parser that matched nothing
    // would make them all pass.
    const total = declarations("font-size").length + declarations("border-radius").length;
    expect(total).toBeGreaterThan(150);
  });

  it("actually adopted the scales (the canary)", () => {
    // Before this pass `var(--v2-fs-` appeared exactly once in the whole stylesheet.
    const fs = declarations("font-size").filter((d) => d.tokenized).length;
    const br = declarations("border-radius").filter((d) => d.tokenized).length;
    expect(fs, "font-size is not going through the type scale").toBeGreaterThan(80);
    expect(br, "border-radius is not going through the radius scale").toBeGreaterThan(30);
  });

  for (const prop of ["font-size", "border-radius"] as const) {
    it(`every off-scale ${prop} value is documented`, () => {
      const undocumented = [
        ...new Set(
          declarations(prop)
            .filter((d) => !d.tokenized)
            .map((d) => d.value)
            .filter((v) => !DOCUMENTED_LITERALS[prop][v]),
        ),
      ];
      expect(
        undocumented,
        `new off-scale ${prop} values — use a scale token, or add a reason to DOCUMENTED_LITERALS`,
      ).toEqual([]);
    });

    it(`the off-scale ${prop} count does not grow`, () => {
      const n = declarations(prop).filter((d) => !d.tokenized).length;
      expect(n, `off-scale ${prop} declarations went UP — this ratchet may only tighten`)
        .toBeLessThanOrEqual(CEILING[prop]);
    });
  }

  it("no documented literal is stale (the list stays honest)", () => {
    // An entry for a value that no longer appears is cover for the next real one.
    for (const prop of ["font-size", "border-radius"] as const) {
      const present = new Set(declarations(prop).filter((d) => !d.tokenized).map((d) => d.value));
      const stale = Object.keys(DOCUMENTED_LITERALS[prop]).filter((v) => !present.has(v));
      expect(stale, `${prop}: these values are gone — drop them from DOCUMENTED_LITERALS`).toEqual([]);
    }
  });

  it("every documented literal carries a real reason", () => {
    for (const prop of Object.keys(DOCUMENTED_LITERALS)) {
      for (const [v, why] of Object.entries(DOCUMENTED_LITERALS[prop])) {
        expect(why.length, `${prop}: ${v} needs an explanation`).toBeGreaterThan(25);
      }
    }
  });
});
