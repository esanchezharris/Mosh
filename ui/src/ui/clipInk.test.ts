// Canvas ink cannot hide from the stylesheet.
//
// WHY THIS EXISTS. The v2 accent pass retired the lime from ~120 selectors and put three
// CSS guards behind that rule. Every one of them reads the STYLESHEET. The single most
// visible colour in the arrangement — the waveform — was a string literal inside a
// `ctx.fillStyle =` in the renderers, so it was invisible to all three, and the wave clip
// went on painting rgba(204,255,35) long after that green had been reserved for agentic
// surfaces. It was found by sampling pixels out of a live canvas, not by any test.
//
// So: the clip renderers may not name a colour. They must read a token, and the token
// must exist on both sides of the bridge (classic :root, and the .v2-shell re-pin).
//
// SCOPE, stated so a green run is not over-read: this covers the three clip renderers in
// the clip renderers. It does not police every canvas in the app — Moshi's character GL, the
// presence meter's FFT and the sample-browser thumb all draw colours of their own. Those
// are separate surfaces with separate arguments; widening this file to them without
// making that argument would be scope, not safety.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readShellCss } from "../v2/cssSource";

const here = dirname(fileURLToPath(import.meta.url));
const arrange = readFileSync(join(here, "clipRenderers.tsx"), "utf8");
const mosh = readFileSync(join(here, "mosh.css"), "utf8");
const shell = readShellCss();

/** The clip renderers, sliced out by their own export statements so the scan cannot
 *  silently widen to the whole file (or narrow to nothing) if the renderers are reordered. */
const RENDERERS = ["ClipWave", "ClipMidi", "ClipDrumGrid"] as const;

function bodyOf(name: string): string {
  const start = arrange.indexOf(`export const ${name} = memo(`);
  if (start === -1) throw new Error(`clipInk: ${name} is no longer an exported memo — this guard has drifted from the code it claims to cover`);
  // up to the next top-level export, or the end
  const rest = arrange.slice(start + 10);
  const next = rest.search(/\nexport (const|function) /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Colour literals a canvas could be painted with: rgb()/rgba()/hsl()/#hex/named. */
const COLOUR_LITERAL = /["'`](?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^)]*\)|red|blue|green|white|black|lime|magenta|cyan|yellow)["'`]/g;

/** A literal is allowed only as the FALLBACK argument of inkOf(el, token, fallback). */
function unguardedLiterals(body: string): string[] {
  const withoutFallbacks = body.replace(/inkOf\([^,]+,\s*["'][^"']+["']\s*,\s*[^)]*\)/g, "inkOf(…)");
  return [...withoutFallbacks.matchAll(COLOUR_LITERAL)].map((m) => m[0]);
}

const TOKENS = ["--clip-ink-wave", "--clip-ink-midi", "--clip-ink-drum", "--clip-ink-drum-lane"] as const;

describe("clip ink — the scan is real (anti-vacuity)", () => {
  it("finds all three renderers and reads real bodies", () => {
    for (const r of RENDERERS) {
      const b = bodyOf(r);
      expect(b.length, `${r}'s body came back empty — every assertion below would pass on nothing`).toBeGreaterThan(200);
      expect(b, `${r} no longer paints a canvas — has it been rewritten?`).toContain("fillStyle");
    }
  });

  it("the literal detector matches something when pointed at a literal", () => {
    // If COLOUR_LITERAL ever stops matching, "no unguarded literals" becomes trivially true.
    expect(unguardedLiterals(`ctx.fillStyle = "rgba(204,255,35,0.5)";`)).toHaveLength(1);
    expect(unguardedLiterals(`ctx.fillStyle = "#ccff23";`)).toHaveLength(1);
    // ...and that it does NOT match the sanctioned fallback position.
    expect(unguardedLiterals(`ctx.fillStyle = inkOf(el, "--clip-ink-wave", "rgba(204,255,35,0.5)");`)).toHaveLength(0);
  });
});

describe("clip ink — renderers name tokens, not colours", () => {
  for (const r of RENDERERS) {
    it(`${r} paints from a token`, () => {
      const body = bodyOf(r);
      expect(
        body,
        `${r} does not call inkOf() — a canvas colour that is not read from a custom property ` +
          `is invisible to every stylesheet guard in this repo, which is how the wave clip kept ` +
          `its lime through the entire accent-reservation pass`,
      ).toContain("inkOf(");
      expect(
        unguardedLiterals(body),
        `${r} names a colour outside the inkOf() fallback position`,
      ).toEqual([]);
    });
  }

  it("no renderer still carries the retired lime as its live value", () => {
    // The fallback may legitimately BE the old literal (degrade to today's rendering).
    // What must not happen is that lime being what actually paints.
    for (const r of RENDERERS) {
      const body = bodyOf(r);
      const live = body.replace(/inkOf\([^)]*\)/g, "");
      expect(live, `${r} still assigns a lime literal directly`).not.toMatch(/204\s*,\s*255|#ccff/i);
    }
  });
});

describe("clip ink — every token exists on both sides of the bridge", () => {
  for (const t of TOKENS) {
    it(`${t} is declared for the classic shell`, () => {
      expect(mosh, `${t} is read by a renderer but never declared in mosh.css`).toContain(`${t}:`);
    });
  }

  it("the v2 shell re-pins the wave ink", () => {
    // The one that HAD to change: it was the last lime in the arrangement.
    expect(shell, "--clip-ink-wave is not re-pinned for .v2-shell").toContain("--clip-ink-wave:");
    const v2Values = [...shell.matchAll(/--clip-ink-wave:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(v2Values.length, "expected --clip-ink-wave in the v2 base and light blocks").toBe(2);
    for (const v of v2Values) {
      expect(v, `the v2 wave ink is lime again: ${v}`).not.toMatch(/204\s*,\s*255|#ccff/i);
    }
  });

  it("the classic values are the pre-token literals (extraction changed no pixels)", () => {
    // Tokenising was a refactor for the classic shell. If these drift, the classic
    // arrangement has silently been restyled by a change that claimed not to touch it.
    const want: Record<string, string> = {
      "--clip-ink-wave": "rgba(204, 255, 35, 0.5)",
      "--clip-ink-midi": "rgba(180, 108, 255, 1)",
      "--clip-ink-drum": "rgba(180, 108, 255, 1)",
      "--clip-ink-drum-lane": "rgba(180, 108, 255, 0.14)",
    };
    for (const [t, v] of Object.entries(want)) {
      const m = mosh.match(new RegExp(`${t}:\\s*([^;]+);`));
      expect(m, `${t} missing from mosh.css`).not.toBeNull();
      expect(m![1].trim(), `${t} no longer matches the literal ClipWave/ClipMidi/ClipDrumGrid used to hardcode`).toBe(v);
    }
  });
});

describe("clip ink — repaints when the theme changes", () => {
  // A canvas does not re-run its draw when a custom property changes. Read a token but
  // leave the theme out of the dependency array and the ink is correct exactly until the
  // first theme flip, then silently stale — a bug that only appears on a toggle nobody
  // exercises in a screenshot test.
  for (const r of RENDERERS) {
    it(`${r} depends on the theme`, () => {
      const body = bodyOf(r);
      expect(body, `${r} does not subscribe to the theme`).toContain("useThemeKey()");
      const deps = body.match(/\}, \[([^\]]*)\]\);/);
      expect(deps, `${r}'s effect dependency array could not be read`).not.toBeNull();
      expect(deps![1], `${r} reads a token but its effect does not re-run on a theme change`).toContain("themeKey");
    });
  }
});
