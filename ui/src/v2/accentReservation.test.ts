// The accent reservation, enforced.
//
// The lime used to be the colour of "on" — play, selection, solo, zoom, loop, faders,
// every hover. 120+ selectors reached it, so it carried no information, and the surfaces
// that genuinely mean "the machine is doing something" (Moshi, a clip mid-render, the
// AI-active pill) wore exactly the same green as a mute button.
//
// The rule now: --v2-accent resolves to the near-white NEUTRAL for the whole shell, and
// only the selectors listed below may re-point it at the AGENTIC family. This file is the
// enforcement, and the list below is the decision — adding a selector here is a deliberate
// act with a written reason, which is the point. Scarcity is the feature.
//
// Reads through readShellCss(), never readFileSync on shell.css — that file is an @import
// manifest, so a direct read returns eleven @import lines and every "not present"
// assertion below would pass vacuously.

import { describe, expect, it } from "vitest";
import { readShellCss } from "./cssSource";

const css = readShellCss();
const code = css.replace(/\/\*[\s\S]*?\*\//g, ""); // comments off — they discuss these tokens

// selector -> why it is allowed the lime. A selector with no entry is a guard failure.
const AGENTIC_SELECTORS: Record<string, string> = {
  ".v2-shell .v2-mosh-stage": "Moshi himself — all moods, hands-free, the live GL mount. The agent IS the character.",
  ".v2-shell .v2-mosh-status": "his status wave and narration line — reads out what the agent is doing",
  ".v2-shell .v2-pill": "the topbar AI ACTIVE pill; .v2-pill has no other user in the shell",
  ".v2-shell .agent-input.listening": "the push-to-talk recognizer is live — the machine is listening right now",
  ".v2-shell .agent-send": "the Ask Moshi submit — the act of handing work to the agent",
  ".v2-shell .v2-agent-drawer": "the drawer while .live: title, step chips, spinner — a task in flight",
  ".v2-shell .v2-skel-confirm": "the mumble-to-skeleton confirm strip — a generative result awaiting a verdict",
  ".v2-shell .v2-flow-syl.ok": "lyric flow: syllables hitting the grid, computed by the flow model",
  ".v2-shell .v2-flow-rhyme.st-perfect": "lyric flow: a perfect rhyme grade, computed by the rhyme model",
  ".v2-shell .v2-clip-badge.working": "a clip mid-render — transcribing / lyrics / flow in flight. Lives in the arrangement partition, which is why the agentic set is semantic and not file-based.",
};

// Non-agentic things that sit INSIDE an agentic scope and would otherwise inherit the lime.
const NEUTRAL_EXCLUSIONS: Record<string, string> = {
  ".v2-shell .v2-live": "multiplayer presence is 'live' but NOT agentic — the owner scoped it out explicitly",
  ".v2-shell .v2-live .led": "the LIVE dot: it stayed lime in the first mockup purely because it sits inside the Mosh card",
  ".v2-shell .v2-agent-btn": "the drawer's generic utility buttons (Undo task, close) — chrome, not the agent",
  ".v2-shell .agent-mic": "the mic control is an input affordance, not a running model",
  ".v2-shell .v2-skel-confirm .v2-btn": "the confirm strip's buttons are ordinary controls inside an agentic strip",
  ".v2-shell .v2-flow-dot.on": "a flow grid dot is a metric readout, not an agent state",
  ".v2-shell .v2-composer-face-btn": "the Moshi mark doubling as the drawer recall toggle — a button, not a state",
  ".v2-shell .v2-composer-plus .fo-trigger": "the File menu '+' — app chrome that happens to live in the composer",
};

// { selector, body } for every rule in the sheet.
const rules: { selector: string; body: string }[] = [];
for (const m of code.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
  rules.push({ selector: m[1].trim(), body: m[2] });
}
const selectorsOf = (r: { selector: string }) => r.selector.split(",").map((s) => s.trim()).filter(Boolean);

describe("accent reservation — the scan is real", () => {
  // Every assertion below is "no bad thing found", so prove the haystack first.
  it("parsed the whole stylesheet", () => {
    expect(rules.length, "rule scan collapsed — the assertions below would all pass on nothing").toBeGreaterThan(200);
  });

  it("found the landmark selectors the reservation depends on", () => {
    const all = rules.flatMap(selectorsOf).join(" | ");
    for (const s of [".v2-clip-badge.working", ".v2-live", ".v2-agent-btn", ".v2-pill"]) {
      expect(all, `missing landmark selector ${s} — wrong or truncated stylesheet`).toContain(s);
    }
  });
});

describe("accent reservation — the token families", () => {
  it("defines both families and derives --v2-accent from the neutral", () => {
    expect(code).toMatch(/--v2-accent-neutral:\s*#f2f2f4/);
    expect(code).toMatch(/--v2-accent-agentic:\s*#ccff36/);
    expect(code).toMatch(/--v2-accent:\s*var\(--v2-accent-neutral\)/);
  });

  it("never re-declares --v2-accent in the light block", () => {
    // v2 keeps dark panels on a cream page, so the near-white neutral is correct in BOTH
    // themes. A light-theme re-declaration of --v2-accent would pin it to a literal and
    // silently break the reservation switch in light only — the hardest kind to notice.
    const light = rules.filter((r) => selectorsOf(r).some((s) => s.includes('[data-theme="light"]')));
    expect(light.length, "no light-theme block found — this check would be vacuous").toBeGreaterThan(0);
    for (const r of light) {
      expect(r.body, `light block re-declares --v2-accent: ${r.selector}`).not.toMatch(/--v2-accent\s*:/);
    }
  });
});

describe("accent reservation — only the agentic set may reach the lime", () => {
  it("every rule re-pointing the accent at the agentic family is on the allowlist", () => {
    const offenders: string[] = [];
    let allowed = 0;
    for (const r of rules) {
      if (!/--v2-accent\s*:\s*var\(--v2-accent-agentic\)/.test(r.body)) continue;
      for (const sel of selectorsOf(r)) {
        if (AGENTIC_SELECTORS[sel]) allowed++;
        else offenders.push(sel);
      }
    }
    // Anti-vacuity: if the agentic block ever stops matching, "no offenders" means nothing.
    expect(allowed, "no allowlisted agentic selectors matched — the block or the regex has drifted").toBeGreaterThanOrEqual(8);
    expect(
      offenders,
      `these selectors take the agentic lime without being on the allowlist in this file. ` +
        `If one is genuinely agentic, add it WITH a reason; scarcity is the point:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every allowlisted selector actually appears in the stylesheet", () => {
    // Stops the allowlist becoming a graveyard of selectors that no longer exist — a stale
    // entry is a standing permission for a rule nobody can see.
    const all = rules.flatMap(selectorsOf);
    for (const sel of Object.keys(AGENTIC_SELECTORS)) {
      expect(all, `allowlisted selector is stale (not in the sheet): ${sel}`).toContain(sel);
    }
  });

  it("every exclusion is real and carries a reason", () => {
    const all = rules.flatMap(selectorsOf);
    for (const [sel, why] of Object.entries(NEUTRAL_EXCLUSIONS)) {
      expect(all, `exclusion is stale (not in the sheet): ${sel}`).toContain(sel);
      expect(why.length, `exclusion ${sel} needs a real reason`).toBeGreaterThan(25);
    }
  });

  it("every agentic entry carries a reason", () => {
    for (const [sel, why] of Object.entries(AGENTIC_SELECTORS)) {
      expect(why.length, `agentic entry ${sel} needs a real reason`).toBeGreaterThan(25);
    }
  });
});
