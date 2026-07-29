import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readShellCss } from "./cssSource";

// THE RULE, enforced:
//
//   A per-theme value must be a TOKEN that the theme block overrides — never a
//   `[data-theme="light"] .foo { prop: … }` element rule.
//
// Because only a token can be RE-PINNED at a nested scope. v2 keeps DARK panels on a
// cream page in the light theme, while mosh.css's classic palette flips wholesale to
// cream/white — so ~15 classic components mounted inside v2 were painting light-ground
// values on a dark ground. Tokens let one block fix all of them; element rules cannot be
// reached at all.
//
// This is the repo's most-repeated bug. It has been found and fixed at least five times
// under different names (.modal/#44, .pop/AGT-MEM-M3, .pr, .auto-panel, .floatwin) and
// each fix was local, so the next surface repeated it. These two guards are the reason
// the sixth one fails the build instead of shipping.

const here = dirname(fileURLToPath(import.meta.url));
const mosh = readFileSync(join(here, "../ui/mosh.css"), "utf8");
const shell = readShellCss();

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const moshCode = stripComments(mosh);
const shellCode = stripComments(shell);

/** Every `[data-theme="light"] …` rule, as {selector, body}. */
function lightRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /(\[data-theme="light"\][^{}]*)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) out.push({ selector: m[1].trim(), body: m[2].trim() });
  return out;
}

/** `--name: value;` pairs in a body. */
const tokensOf = (body: string) =>
  new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

/** Declarations in a body that are NOT custom properties. */
const plainDecls = (body: string) =>
  body.split(";").map((d) => d.trim()).filter(Boolean).filter((d) => !d.startsWith("--"));

const MOSH_LIGHT = lightRules(moshCode);
const SHELL_LIGHT = lightRules(shellCode);

// The one legitimate per-element theme rule, declared with a reason the way
// UI_REACH_GAPS declares its entries. Shrink-only: adding to this list means shipping
// another surface that a nested re-pin cannot reach.
const ELEMENT_RULE_EXCEPTIONS: Record<string, string> = {};

// Classic tokens the light block flips that v2 deliberately does NOT re-pin, with why.
const DELIBERATE_LIGHT_INHERITS: Record<string, string> = {
  "--danger":
    "the .error-bar (RecoveryNotice / MissingMediaBanner) is a DIRECT child of .v2-shell, so it sits on the cream PAGE rather than inside a dark panel — it stays light, like v2's own .v2-errbar. Scoped back on `.v2-shell > .error-bar`.",
  "--danger-deep": "same .error-bar exception as --danger.",
  "--danger-line": "same .error-bar exception as --danger.",
  "--pr-offkey":
    "the piano-roll out-of-key veil is an alpha wash whose value depends on the grid it sits on; the v2 value is set unconditionally in the .v2-shell base block, not per theme.",
  "--pr-row-alt": "same alpha-wash reasoning as --pr-offkey; set unconditionally in the .v2-shell base block.",
  "--pr-key-white-bg": "re-pinned unconditionally in the .v2-shell base block (v2 panels are dark in BOTH themes, so there is nothing to flip).",
  "--pr-key-black-bg": "re-pinned unconditionally in the .v2-shell base block.",
  "--pr-key-line": "re-pinned unconditionally in the .v2-shell base block.",
  "--pr-note-edge": "re-pinned unconditionally in the .v2-shell base block.",
};

describe("theme tokens: the parser sees real stylesheets (anti-vacuity)", () => {
  // Every assertion below is "no bad thing found", so a parser that quietly matched
  // nothing would make all of them pass. Pin the shapes first.
  it("finds the light blocks it is about to check", () => {
    expect(MOSH_LIGHT.length, "no [data-theme=light] rules found in mosh.css").toBeGreaterThan(0);
    expect(SHELL_LIGHT.length, "no [data-theme=light] rules found in shell.css").toBeGreaterThan(0);
  });

  it("finds a real classic light palette", () => {
    const root = MOSH_LIGHT.find((r) => r.selector === '[data-theme="light"]');
    expect(root, "the classic [data-theme=light] token block is missing").toBeDefined();
    expect(tokensOf(root!.body).size).toBeGreaterThan(10);
  });
});

describe("comments do not swallow rules", () => {
  // Found by this file's own parser: a comment reading "the shared pop-*/cmdlog-* tokens"
  // TERMINATED at `pop-*/`, so the rest of the sentence became CSS — and the browser then
  // discarded the following `.mem-tier { … }` rule as part of the garbage selector. The
  // memory panel's tier layout and separators had been silently dead. A `*/` inside comment
  // prose is invisible in review and costs the NEXT rule, not the comment.
  for (const [name, css] of [["mosh.css", mosh], ["shell.css", shell]] as const) {
    it(`${name} has no comment that ends early`, () => {
      const offenders: string[] = [];
      const re = /\/\*([\s\S]*?)\*\//g;
      for (const m of css.matchAll(re)) {
        // Text between this comment's end and the next `/*` must look like CSS, not prose.
        const after = css.slice(m.index! + m[0].length);
        const nextOpen = after.indexOf("/*");
        const between = (nextOpen === -1 ? after : after.slice(0, nextOpen));
        // Prose leaking out reads as words followed by a stray `*/`.
        if (/\*\//.test(between)) offenders.push(m[0].slice(0, 60).replace(/\s+/g, " ") + "…");
      }
      expect(offenders, "a stray */ inside comment prose ends it early and eats the next rule").toEqual([]);
    });
  }
});

describe("3A — no per-element theme overrides", () => {
  it("every declaration inside a [data-theme=light] rule is a custom property", () => {
    const offenders: string[] = [];
    for (const { selector, body } of [...MOSH_LIGHT, ...SHELL_LIGHT]) {
      if (ELEMENT_RULE_EXCEPTIONS[selector]) continue;
      const plain = plainDecls(body);
      if (plain.length > 0) offenders.push(`${selector} → ${plain.join("; ")}`);
    }
    expect(
      offenders,
      "a per-theme value must be a token the theme block overrides, not an element rule — " +
        "an element rule cannot be re-pinned for the v2 subtree",
    ).toEqual([]);
  });

  it("every declared exception carries a real reason", () => {
    for (const [sel, why] of Object.entries(ELEMENT_RULE_EXCEPTIONS)) {
      expect(why.length, `exception ${sel} needs an explanation`).toBeGreaterThan(25);
    }
  });
});

describe("3B — v2 accounts for every classic token that flips", () => {
  const classicLight = tokensOf(MOSH_LIGHT.find((r) => r.selector === '[data-theme="light"]')!.body);
  const v2Light = tokensOf(SHELL_LIGHT.find((r) => r.selector === '[data-theme="light"] .v2-shell')!.body);
  // The .v2-shell BASE block also re-pins tokens (values identical in both themes).
  const v2Base = (() => {
    const at = shellCode.indexOf(".v2-shell {");
    return tokensOf(shellCode.slice(at, shellCode.indexOf("\n}", at)));
  })();

  it("parses both sides (anti-vacuity)", () => {
    expect(classicLight.size).toBeGreaterThan(10);
    expect(v2Light.size).toBeGreaterThan(10);
    expect(v2Base.size).toBeGreaterThan(20);
  });

  it("re-pins, or explicitly excepts, every classic token the light theme flips", () => {
    // A classic token that flips to a light-ground value and is NOT re-pinned for v2
    // resolves to that light value on v2's dark panels. That is the white-slab bug's
    // exact mechanism, and it applies to every classic component v2 mounts.
    const unaccounted = [...classicLight.keys()].filter(
      (name) => !v2Light.has(name) && !v2Base.has(name) && !DELIBERATE_LIGHT_INHERITS[name],
    );
    expect(unaccounted, "classic tokens that flip light but are never re-pinned for v2").toEqual([]);
  });

  it("every deliberate inherit carries a real reason", () => {
    for (const [name, why] of Object.entries(DELIBERATE_LIGHT_INHERITS)) {
      expect(why.length, `${name} needs an explanation`).toBeGreaterThan(25);
    }
  });

  it("does not except tokens that are actually re-pinned (the list stays honest)", () => {
    // An exception for a token v2 DOES handle is dead weight that hides the next real one.
    const stale = Object.keys(DELIBERATE_LIGHT_INHERITS).filter(
      (name) => v2Light.has(name) && !name.startsWith("--danger"),
    );
    expect(stale, "these are re-pinned for v2 — drop them from DELIBERATE_LIGHT_INHERITS").toEqual([]);
  });
});
