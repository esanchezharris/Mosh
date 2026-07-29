// Glow is reserved the same way the accent is.
//
// The shell used to bloom in thirteen places: a radial-gradient ground behind the whole
// app, a 50px zero-spread halo under every floating panel, a 22px glow on each track icon
// scaled by signal level, a 38px wash inside each lane doing the same, and haloes on the
// play button, record arm, playhead, presence dots and status dots.
//
// None of it carried information. Level was already shown twice — by TrackMeterBar and by
// the crisp 2px inset edge on the lane — so the two level glows were decoration layered on
// top of two working indicators. The rest was atmosphere.
//
// The rule now matches the accent rule: a COLOURED glow is legal only where the machine is
// doing something. Everything else separates with a hairline, an edge or a value step.
//
// Hairline rings (`0 0 0 1px`) are not glow and are not covered here — they are borders
// drawn as shadows, which is a legitimate and common technique.

import { describe, expect, it } from "vitest";
import { readShellCss } from "./cssSource";

const css = readShellCss();
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

// selector -> why this one may still glow.
const GLOW_ALLOWED: Record<string, string> = {
  ".v2-pill .led": "the topbar AI ACTIVE indicator — the one place a soft halo means 'a model is running'",
  ".v2-shell .agent-input.listening": "the push-to-talk ring while the recognizer is live (a 1px ring, kept for completeness)",
};

const rules: { selector: string; body: string }[] = [];
for (const m of code.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
  rules.push({ selector: m[1].trim(), body: m[2] });
}
const selectorsOf = (r: { selector: string }) => r.selector.split(",").map((s) => s.trim()).filter(Boolean);

// Is this declaration a GLOW? A regex over the raw value is not good enough: `inset 0 0 0
// 1px` — a hairline ring — contains the substring "0 0" followed by "1px" and matches a
// naive pattern by sliding. So parse it properly: split into comma-separated layers, drop
// `inset`, take the leading lengths, and read the BLUR (the 3rd length). Blur > 0 is a
// glow; blur 0 with a spread is a ring, which is a border drawn as a shadow and fine.
function isGlow(body: string): boolean {
  const m = body.match(/box-shadow\s*:\s*([^;]+)/);
  if (!m) return false;
  // split on commas that are not inside parentheses (color-mix/rgba/calc contain commas)
  const layers: string[] = [];
  let depth = 0, cur = "";
  for (const ch of m[1]) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { layers.push(cur); cur = ""; continue; }
    cur += ch;
  }
  layers.push(cur);
  for (const raw of layers) {
    const layer = raw.replace(/\binset\b/, "").trim();
    // A NEUTRAL blurred shadow is elevation, not bloom: `0 3px 12px rgba(0,0,0,.35)` under
    // a clip is a drop shadow doing an honest job. Only a COLOURED blur is the glow this
    // pass is about, so skip anything whose colour is black.
    if (/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]|#000\b|#000000\b|\bblack\b/.test(layer)) continue;
    // a calc() in the blur slot is level-driven glow
    if (/^\S+\s+\S+\s+calc\(/.test(layer)) return true;
    const lengths = layer.match(/^(-?\d*\.?\d+(?:px)?)\s+(-?\d*\.?\d+(?:px)?)\s+(-?\d*\.?\d+(?:px)?)/);
    if (!lengths) continue;
    if (parseFloat(lengths[3]) > 0) return true;
  }
  return false;
}

describe("glow reservation — the scan is real", () => {
  it("parsed the whole stylesheet", () => {
    expect(rules.length, "rule scan collapsed — every assertion below would pass on nothing").toBeGreaterThan(200);
  });

  it("the glow detector still matches something", () => {
    // If GLOW ever stops matching, "no unauthorised glow" becomes trivially true.
    const hits = rules.filter((r) => isGlow(r.body));
    expect(hits.length, "the glow detector matched nothing at all — it has drifted from the CSS").toBeGreaterThan(0);
  });
});

describe("glow reservation — the ground does not bloom", () => {
  it("--v2-bg is a flat colour in both themes", () => {
    const decls = [...code.matchAll(/--v2-bg:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length, "expected --v2-bg in the base and light blocks").toBe(2);
    for (const v of decls) {
      expect(v, `--v2-bg is a gradient again: ${v}`).not.toMatch(/gradient/i);
    }
  });

  it("--v2-shadow pulls its spread in rather than haloing", () => {
    // A wide blur at zero spread is the same bloom the ground had, just under a panel.
    const decls = [...code.matchAll(/--v2-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length, "expected --v2-shadow in the base and light blocks").toBe(2);
    for (const v of decls) {
      expect(v, `--v2-shadow has no negative spread: ${v}`).toMatch(/-\d+px\s+rgba/);
    }
  });
});

describe("glow reservation — only agentic surfaces may glow", () => {
  it("every blurred shadow is on the allowlist", () => {
    const offenders: string[] = [];
    let allowed = 0;
    for (const r of rules) {
      if (!isGlow(r.body)) continue;
      for (const sel of selectorsOf(r)) {
        if (GLOW_ALLOWED[sel]) allowed++;
        else offenders.push(`${sel}  ->  ${r.body.trim().slice(0, 80)}`);
      }
    }
    expect(allowed, "no allowlisted glow matched — the allowlist or the regex has drifted").toBeGreaterThanOrEqual(1);
    expect(
      offenders,
      `these selectors glow without being on the allowlist. Glow is reserved for surfaces ` +
        `where the machine is working; separate with a hairline, an edge or a value step ` +
        `instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no level-driven glow — level is shown by the meter and the lane edge, not a halo", () => {
    // The specific regression this pass exists to prevent: bloom used AS the meter.
    for (const r of rules) {
      if (!/--lvl/.test(r.body)) continue;
      expect(
        isGlow(r.body),
        `${r.selector} drives a blurred shadow from --lvl — glow-as-level-meter is back`,
      ).toBe(false);
    }
  });

  it("every allowlisted glow selector is real and carries a reason", () => {
    const all = rules.flatMap(selectorsOf);
    for (const [sel, why] of Object.entries(GLOW_ALLOWED)) {
      expect(all, `allowlisted glow selector is stale (not in the sheet): ${sel}`).toContain(sel);
      expect(why.length, `glow entry ${sel} needs a real reason`).toBeGreaterThan(25);
    }
  });
});
