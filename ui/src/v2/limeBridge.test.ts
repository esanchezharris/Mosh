// Half-bridged controls.
//
// .v2-shell re-pins the classic --lime family to the neutral so the ~15 components v2
// mounts out of ui/src/ui stop painting the old green. A re-pin can only move a TOKEN. So
// a rule that paints from `var(--lime)` AND from a hardcoded lime-family literal comes out
// of the bridge with half its colours moved and half not.
//
// That is not hypothetical. `.dr-cell.on` was `background: var(--lime); border-color:
// #97c01a`, and after the bridge a lit drum step was a near-white pad wearing a saturated
// olive ring — one control, two palettes. The literal was the SAME colour as --pr-note-edge
// two hundred lines up, which is a token and is re-pinned; the drum cell simply never got
// that treatment. It shipped past the accent-reservation guard (which reads only the v2
// partitions, never mosh.css), past pianoRollCss.test.ts (whose no-literals scan stops one
// line short, at the drum-sequencer banner), and past the shell baselines (which never open
// the drum window). Two independent review lenses found it by rendering the real DOM.
//
// So: in mosh.css, a rule may not mix a bridged --lime* token with a lime-family colour
// literal — unless it is declared below as classic-only, with the reason it cannot be
// reached from AppV2. Shrink-only: an addition to that list is a claim about the module
// graph, and those age (see the UI_REACH_GAPS post-mortem).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mosh = readFileSync(join(here, "../ui/mosh.css"), "utf8");
const code = mosh.replace(/\/\*[\s\S]*?\*\//g, "");

// Rules that legitimately hold lime literals: the token declaration blocks themselves.
// That IS where a literal belongs — the whole point is that everything else names a token.
const TOKEN_BLOCKS = /^(:root|\[data-theme="light"\]|\[data-skin=)/;

// Selectors allowed to mix, because they cannot render inside .v2-shell. Each entry is a
// claim about AppV2's module graph — verify it before trusting it.
const CLASSIC_ONLY: Record<string, string> = {
  ".take-lane.current":
    "take lanes are rendered by classic Arrange.tsx (the .take-lanes block around its ClipBlock); v2's ClipView.tsx imports only the canvas draw functions from that module and has no take-lane surface of its own.",
  ".band.loop":
    "the classic ruler's loop band, rendered by Arrange.tsx; v2 draws its own loop region in timeline/TimeRangeBand.tsx and never mounts classic Arrange as a component.",
  ".band.range":
    "the classic ruler's time-range band, rendered by Arrange.tsx; v2's equivalent is timeline/TimeRangeBand.tsx, which paints from --v2-* tokens.",
};

/** Colour literals whose green channel clearly dominates — the lime family. */
function limeLiterals(body: string): string[] {
  // A var() FALLBACK (`var(--lime, #b6ff3c)`) is not a second declaration: the literal only
  // paints if the token is undefined, which the bridge guarantees it is not.
  const s = body.replace(/var\(--[\w-]+\s*,\s*[^)]*\)/g, "var(X)");
  const out: string[] = [];
  for (const m of s.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    if (g > 150 && g - r > 25 && g - b > 60) out.push(m[0]);
  }
  for (const m of s.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    if (g > 150 && g - r > 25 && g - b > 60) out.push(m[0]);
  }
  return out;
}

const rules: { selector: string; body: string; line: number }[] = [];
for (const m of code.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
  rules.push({
    selector: m[1].trim(),
    body: m[2],
    line: code.slice(0, m.index!).split("\n").length,
  });
}

const mixed = rules.filter(
  (r) => !TOKEN_BLOCKS.test(r.selector) && /var\(--lime/.test(r.body) && limeLiterals(r.body).length > 0,
);

describe("lime bridge — the scan is real (anti-vacuity)", () => {
  it("parsed mosh.css", () => {
    expect(rules.length, "rule scan collapsed — every assertion below would pass on nothing").toBeGreaterThan(400);
  });

  it("still finds rules that paint from the bridged tokens", () => {
    // If nothing references var(--lime) any more, "no half-bridged rule" is vacuous.
    const consumers = rules.filter((r) => !TOKEN_BLOCKS.test(r.selector) && /var\(--lime/.test(r.body));
    expect(consumers.length, "no rule paints from --lime — has the family been renamed?").toBeGreaterThan(40);
  });

  it("the literal detector fires on the colour that caused this", () => {
    expect(limeLiterals("border-color: #97c01a;")).toEqual(["#97c01a"]);
    expect(limeLiterals("background: rgba(204, 255, 35, 0.16);")).toHaveLength(1);
    // ...and not on a neutral, nor on a var() fallback it must ignore.
    expect(limeLiterals("color: #f6f2eb;")).toEqual([]);
    expect(limeLiterals("color: var(--lime, #b6ff3c);")).toEqual([]);
  });
});

describe("lime bridge — no half-bridged control", () => {
  it("every rule mixing a --lime token with a lime literal is declared classic-only", () => {
    const offenders = mixed
      .filter((r) => !CLASSIC_ONLY[r.selector])
      .map((r) => `mosh.css:${r.line}  ${r.selector}  ->  ${limeLiterals(r.body).join(", ")}`);
    expect(
      offenders,
      "these paint from a bridged --lime token AND a hardcoded lime literal. Under .v2-shell " +
        "the token half goes neutral and the literal half stays green, which is one control " +
        "wearing two palettes. Tokenise the literal (see --step-on-edge / --pr-note-edge), or " +
        "declare the selector classic-only with the reason it cannot reach AppV2:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("every classic-only exception is real and carries a reason", () => {
    const seen = new Set(rules.map((r) => r.selector));
    for (const [sel, why] of Object.entries(CLASSIC_ONLY)) {
      expect(seen, `classic-only exception is stale (no such rule in mosh.css): ${sel}`).toContain(sel);
      expect(why.length, `${sel} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("the exception list stays honest — no entry for a rule that no longer mixes", () => {
    // An exception for a rule someone has since tokenised is dead weight that hides the next
    // real one, the same way a stale UI_REACH_GAPS entry hid a missing delete-track control.
    const stillMixing = new Set(mixed.map((r) => r.selector));
    const stale = Object.keys(CLASSIC_ONLY).filter((s) => !stillMixing.has(s));
    expect(stale, "these no longer mix a token with a literal — drop them from CLASSIC_ONLY").toEqual([]);
  });
});

describe("lime bridge — the drum step ring moves with its fill", () => {
  it("--step-on-edge is a token in classic and re-pinned for v2", () => {
    expect(mosh, "--step-on-edge missing from mosh.css").toMatch(/--step-on-edge:\s*#97c01a;/);
    expect(mosh, ".dr-cell.on paints its ring from a literal again").toMatch(
      /\.dr-cell\.on\s*\{[^}]*border-color:\s*var\(--step-on-edge\)/,
    );
  });
});
