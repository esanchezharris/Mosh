import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The MIDI editor's rules live in mosh.css and V3 re-pins their tokens, so it cannot read
// either palette directly. Everything it paints goes through the --pr-* family: defined
// in mosh.css, re-pinned under .v3-shell in v3/tokens.css.
//
// These guards exist because of a real, shipped bug. `.pr-key.white` hardcoded
// `background: #171715` (near-black) while its label colour was `var(--bone-dim)`, which
// flips to DARK in the light theme — the shipped default. Every note name on the keyboard
// was rendered and invisible. `.pr-row.black`'s `rgba(0,0,0,0.28)` was the same mistake in
// a quieter key: subtle on near-black ink, heavy grey stripes on cream. And `.pr` set a
// background with no `color`, so inside v2 it inherited near-white text onto a white panel.
//
// The lesson the repo keeps re-learning (see CLAUDE.md "Gotchas", and the .modal/#44 and
// .pop/AGT-MEM fixes in mosh.css) is that a per-theme value must live in a token that the
// theme block overrides — never as a literal in the rule. These tests enforce exactly that.

const here = dirname(fileURLToPath(import.meta.url));
const mosh = readFileSync(join(here, "mosh.css"), "utf8");
const v3Tokens = readFileSync(join(here, "../v3/tokens.css"), "utf8");

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const moshCode = stripComments(mosh);
const v3Code = stripComments(v3Tokens);

/** Every rule whose selector is panel-scoped to the piano roll (`.pr`, `.pr-foo`, …).
 *  Deliberately excludes `.pr-name` / `.pr-meta` when they appear on a PLUGIN row —
 *  that prefix is overloaded in this stylesheet (mosh.css ~815). We match only rules
 *  inside the piano-roll section, located by its section banner. */
function pianoRollRules(): { selector: string; body: string }[] {
  const start = mosh.indexOf("/* ── piano roll (MIDI editor)");
  expect(start, "piano-roll section banner not found in mosh.css").toBeGreaterThan(-1);
  const end = mosh.indexOf("/* drum step sequencer", start);
  expect(end, "drum-sequencer section banner not found after the piano roll").toBeGreaterThan(start);
  const section = stripComments(mosh.slice(start, end));
  return [...section.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2].trim(),
  }));
}

const RULES = pianoRollRules();

/** `--name: value;` declarations inside a given block, keyed by name. */
function tokensIn(css: string, blockSelector: string): Map<string, string> {
  const at = css.indexOf(blockSelector + " {");
  if (at < 0) return new Map();
  const body = css.slice(at + blockSelector.length + 2, css.indexOf("}", at));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const ROOT = tokensIn(moshCode, ":root");
const LIGHT = tokensIn(moshCode, '[data-theme="light"]');
const V3 = tokensIn(v3Code, ".v3-shell");

/** Lengths, not colours: sizes are theme-invariant, so they need neither a light twin
 *  nor a v2 re-pin. Anything that resolves to a colour does need both. */
const isLength = (v: string) => /^(min|max|calc)\(|^-?[\d.]+(px|vw|vh|%|em|rem)$/.test(v.trim());
const prColorTokens = (m: Map<string, string>) =>
  [...m.entries()].filter(([n, v]) => n.startsWith("--pr-") && !isLength(v)).map(([n]) => n);

describe("piano roll: the parser sees a real stylesheet (anti-vacuity)", () => {
  // Every assertion below is of the form "no bad thing found". A parser that silently
  // matched nothing would make all of them pass. Pin the shapes first.
  it("finds the piano-roll rule block", () => {
    expect(RULES.length).toBeGreaterThan(15);
    expect(RULES.map((r) => r.selector)).toContain(".pr-key.white");
  });

  it("finds the token blocks it is about to compare", () => {
    expect(ROOT.size).toBeGreaterThan(20);
    expect(LIGHT.size).toBeGreaterThan(10);
    expect(V3.size).toBeGreaterThan(20);
    expect(ROOT.has("--pr-key-white-bg")).toBe(true);
  });
});

describe("piano roll: no colour literals in the rules", () => {
  it("paints every colour through a token", () => {
    // The exact regression: #171715, rgba(0,0,0,0.28), rgba(0,0,0,0.4), #97c01a, #fff.
    const offenders: string[] = [];
    for (const { selector, body } of RULES) {
      // Strip var(...) fallbacks are not used here; any hex/rgb/hsl left is a literal.
      const hits = body.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
      if (hits) offenders.push(`${selector} → ${hits.join(", ")}`);
    }
    expect(offenders, "colour literals must be tokens so the theme block can flip them").toEqual([]);
  });

  it("sets a colour wherever it sets a panel background", () => {
    // `.pr` inherits from whichever shell mounts it. v2's ambient text is near-white
    // while this panel's own background is white in the classic light theme — an unset
    // colour is invisible text. Same fix as .modal (#44) and .pop (AGT-MEM/M3).
    const panel = RULES.find((r) => r.selector === ".pr");
    expect(panel, "no .pr rule found").toBeDefined();
    expect(panel!.body).toMatch(/background:\s*var\(--pr-panel\)/);
    expect(panel!.body, ".pr sets a background but no colour").toMatch(/(^|;)\s*color:\s*var\(--pr-/);
  });
});

describe("piano roll: every literal token has a light-theme twin", () => {
  it("declares a [data-theme=light] override for each --pr-* literal in :root", () => {
    // A --pr-* whose :root value is itself a var() flips for free with the classic
    // palette. One written as a literal does NOT — and a literal tuned against a dark
    // ground is precisely how the key labels went invisible.
    const missing: string[] = [];
    for (const [name, value] of ROOT) {
      if (!name.startsWith("--pr-") || isLength(value)) continue;
      const isLiteral = /^#|^rgba?\(|^hsla?\(/.test(value);
      if (isLiteral && !LIGHT.has(name)) missing.push(`${name}: ${value}`);
    }
    expect(missing, "literal --pr-* tokens with no light-theme override").toEqual([]);
  });
});

describe("piano roll: V3 re-pins the whole family", () => {
  it("covers every --pr-* colour token the classic stylesheet defines", () => {
    // A token defined only in mosh.css resolves to the mosh.css value inside .v3-shell —
    // cream in the light theme, on V3's dark panel (the white-slab bug's mechanism).
    const classic = prColorTokens(ROOT);
    const uncovered = classic.filter((n) => !V3.has(n));
    expect(uncovered, "--pr-* colour tokens V3 never re-pins").toEqual([]);
    expect(classic.length, "expected a real --pr-* family").toBeGreaterThan(10);
  });

  it("pins every SURFACE to an opaque value (the editor sits over the lanes)", () => {
    // A translucent surface would composite the arrangement's own clips and gridlines
    // through the editor's grid (the "transparent piano roll" bug).
    const SURFACES = ["--pr-panel", "--pr-grid-bg", "--pr-key-white-bg", "--pr-key-black-bg", "--pr-ruler-bg", "--pr-vel-bg"];
    const TRANSLUCENT = /rgba\([^)]*,\s*0?\.\d|hsla\(|transparent/;
    const bad: string[] = [];
    for (const name of SURFACES) {
      const value = V3.get(name);
      expect(value, `V3 never re-pins ${name}`).toBeDefined();
      if (value && TRANSLUCENT.test(value)) bad.push(`${name}: ${value}`);
    }
    expect(bad, "editor surfaces must be opaque, not translucent").toEqual([]);
  });
});
