import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The MIDI editor is mounted by BOTH shells (AppLegacy and AppV2), so it cannot read
// either palette directly. Everything it paints goes through the --pr-* family: defined
// in mosh.css for the classic shell, re-pinned under .v2-shell in v2/shell.css.
//
// These guards exist because of a real, shipped bug. `.pr-key.white` hardcoded
// `background: #171715` (near-black) while its label colour was `var(--bone-dim)`, which
// flips to DARK in the light theme — the shipped default. Every note name on the keyboard
// was rendered and invisible. `.pr-row.black`'s `rgba(0,0,0,0.28)` was the same mistake in
// a quieter key: subtle on near-black ink, heavy grey stripes on cream. And `.pr` set a
// background with no `color`, so inside v2 it inherited near-white text onto a white panel.
//
// The lesson the repo keeps re-learning (see docs/worklog, and the .modal/#44 and
// .pop/AGT-MEM fixes in mosh.css) is that a per-theme value must live in a token that the
// theme block overrides — never as a literal in the rule. These tests enforce exactly that.

const here = dirname(fileURLToPath(import.meta.url));
const mosh = readFileSync(join(here, "mosh.css"), "utf8");
const shell = readFileSync(join(here, "../v2/shell.css"), "utf8");

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const moshCode = stripComments(mosh);
const shellCode = stripComments(shell);

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
const V2 = tokensIn(shellCode, ".v2-shell");

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
    expect(V2.size).toBeGreaterThan(20);
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

describe("piano roll: v2 re-pins the whole family", () => {
  it("covers every --pr-* token the classic shell defines", () => {
    // A token defined only in mosh.css resolves to the CLASSIC value inside v2 — cream
    // in the light theme, on v2's dark panel. That is the white-slab bug's mechanism.
    const classic = prColorTokens(ROOT);
    const uncovered = classic.filter((n) => !V2.has(n));
    expect(uncovered, "--pr-* colour tokens v2 never re-pins").toEqual([]);
    expect(classic.length, "expected a real --pr-* family").toBeGreaterThan(10);
  });

  it("re-pins them to v2 tokens, not to fresh literals", () => {
    // v2's own values already flip per theme, so riding them keeps the panel dark in
    // both. A literal here would need its own light twin and would drift.
    const bad: string[] = [];
    for (const [name, value] of V2) {
      if (!name.startsWith("--pr-")) continue;
      if (name === "--pr-row-alt" || name === "--pr-offkey") continue; // alpha veils over a known-dark ground
      if (!value.includes("var(--v2-")) bad.push(`${name}: ${value}`);
    }
    expect(bad, "v2 --pr-* values should derive from --v2-* tokens").toEqual([]);
  });
});
