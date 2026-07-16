// ============================================================================
// ARENA VERIFY RUNNER — the mechanical self-testing loop.
//
// Loads every wall candidate in headless Chromium (real rAF, real pointer events —
// none of the Browser-pane gotchas), wrapped by the EXACT same wrapHtml the arena
// harness uses (imported through Vite for parity), then:
//   1. generic checks     — console/page errors, horizontal+vertical overflow,
//                           canvases present + painted
//   2. per-target suites  — real mouse gestures asserting the interaction contract
//                           (rail: grid reveal / anchor-preserving snap / ⌘ goo / trim /
//                            select / hold-Moshi-to-talk · monument: take loop / rings /
//                            hit-targets / scrub)
//   3. state screenshots  — arena/.verify/<seed>/NN-name.png (the vision panel's input)
//
// Usage:  node tools/verify/run.mjs            (arena dev server must be on :5273)
// Exit 1 if any check fails. Report: arena/.verify/report.json
// ============================================================================
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arenaDir = resolve(here, "../..");
const req = createRequire(resolve(arenaDir, "../ui/package.json")); // reuse ui's playwright
const { chromium } = req("playwright");

const BASE = "http://localhost:5273";
const DESIGN = { shell: [1440, 900], companion: [390, 844] };
const OUT = resolve(arenaDir, ".verify");

const results = [];
let shotIdx = 0;

function check(cand, name, ok, detail = "") {
  cand.checks.push({ name, ok: !!ok, detail: String(detail) });
  const mark = ok ? "  ✓" : "  ✗ FAIL";
  console.log(`${mark} ${name}${detail ? "  — " + detail : ""}`);
  return !!ok;
}

async function shot(page, cand, name) {
  const dir = resolve(OUT, cand.seed);
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, `${String(++shotIdx).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: p });
  cand.screenshots.push(p);
}

// close-up: clip-capture a region (element rect + padding) — the page lives in a
// deviceScaleFactor-3 context, so these come out at 3× native resolution. The vision
// panel misread tiny components in full-frame shots (Moshi as "a muddy blob"); close-ups
// with intent labels are the fix.
async function closeup(page, cand, name, rect, pad = 14) {
  const dir = resolve(OUT, cand.seed);
  mkdirSync(dir, { recursive: true });
  const vp = page.viewportSize();
  const x = Math.max(0, rect.x - pad), y = Math.max(0, rect.y - pad);
  const clip = {
    x, y,
    width: Math.min(vp.width - x, rect.width + pad * 2 + Math.min(0, rect.x - pad) * -1),
    height: Math.min(vp.height - y, rect.height + pad * 2 + Math.min(0, rect.y - pad) * -1),
  };
  const p = resolve(dir, `cu-${name}.png`);
  await page.screenshot({ path: p, clip });
  cand.closeups.push(p);
}
const rectOf = (page, sel, growTop = 0, growLeft = 0) =>
  page.evaluate(([sel, gt, gl]) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left - gl, y: r.top - gt, width: r.width + gl, height: r.height + gt };
  }, [sel, growTop, growLeft]);

// ---------------------------------------------------------------------------
async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const ctx3 = await browser.newContext({ deviceScaleFactor: 3 }); // close-up captures

  // bootstrap: build wrapped docs with the REAL wrapHtml via Vite (exact harness parity)
  const boot = await ctx.newPage();
  await boot.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const cands = await boot.evaluate(async () => {
    const mod = await import("/src/harness/sandbox.ts");
    const j = await (await fetch("/api/arena/generated")).json();
    return j.candidates.map((c) => ({
      id: c.id, title: c.title, target: c.target, seed: c.seed,
      doc: mod.wrapHtml(c.source, c.theme ?? "dark", {
        moshi: !!c.usesMoshi || ["moshi", "stage", "companion"].includes(c.target),
      }),
    }));
  });
  await boot.close();
  console.log(`\nARENA VERIFY — ${cands.length} candidate(s) on the wall\n`);

  for (const c of cands) {
    shotIdx = 0;
    const cand = { id: c.id, title: c.title, target: c.target, seed: c.seed, checks: [], screenshots: [], closeups: [] };
    results.push(cand);
    console.log(`── ${c.title} [${c.target}] ──`);

    const [W, H] = DESIGN[c.target] ?? [1440, 900];
    const page = await ctx.newPage();
    await page.setViewportSize({ width: W, height: H });
    const consoleErrs = [], pageErrs = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
    page.on("pageerror", (e) => pageErrs.push(String(e)));
    await page.setContent(c.doc, { waitUntil: "load" });
    await page.waitForTimeout(1400); // moshi boot + first draws

    // ---- generic checks ----
    const geo = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, iw: innerWidth,
      sh: document.documentElement.scrollHeight, ih: innerHeight,
      canvases: [...document.querySelectorAll("canvas")].length,
      painted2d: [...document.querySelectorAll("canvas")].filter((cv) => {
        try {
          const g = cv.getContext("2d");
          if (!g) return false; // webgl canvases screenshot-verify instead
          const d = g.getImageData(0, 0, Math.min(cv.width, 400), Math.min(cv.height, 200)).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
          return false;
        } catch { return false; }
      }).length,
    }));
    check(cand, "no horizontal overflow", geo.sw <= geo.iw + 1, `${geo.sw} vs ${geo.iw}`);
    check(cand, "no vertical overflow", geo.sh <= geo.ih + 1, `${geo.sh} vs ${geo.ih}`);
    await shot(page, cand, "rest");

    // ---- per-target suite (Sequencer FIRST — its title also contains "Rail") ----
    if (/Sequencer/i.test(c.title) && c.target === "shell") await sequencerSuite(page, cand);
    else if (/Rail/i.test(c.title) && c.target === "shell") await railSuite(page, cand);
    else if (/Monument/i.test(c.title) && c.target === "companion") await monumentSuite(page, cand);
    else console.log("  (no gesture suite for this target — generic checks only)");

    // errors LAST so suite-triggered errors count too
    check(cand, "0 console errors", consoleErrs.length === 0, consoleErrs.slice(0, 3).join(" | "));
    check(cand, "0 uncaught page errors", pageErrs.length === 0, pageErrs.slice(0, 3).join(" | "));
    await page.close();

    // ---- close-up capture pass (3× DSF) — re-drive every state we want the vision panel to judge
    const cu = await ctx3.newPage();
    await cu.setViewportSize({ width: W, height: H });
    await cu.setContent(c.doc, { waitUntil: "load" });
    await cu.waitForTimeout(1400);
    if (/Sequencer/i.test(c.title) && c.target === "shell") await sequencerCloseups(cu, cand);
    else if (/Rail/i.test(c.title) && c.target === "shell") await railCloseups(cu, cand);
    else if (/Monument/i.test(c.title) && c.target === "companion") await monumentCloseups(cu, cand);
    await cu.close();
    console.log(`  ⤷ ${cand.closeups.length} close-ups captured @3×`);
    console.log("");
  }

  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "report.json"), JSON.stringify(results, null, 2));
  const flat = results.flatMap((r) => r.checks);
  const fails = flat.filter((k) => !k.ok);
  console.log(`════ ${flat.length - fails.length}/${flat.length} checks passed ════`);
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  ✗ " + f.name + " — " + f.detail)); }
  process.exit(fails.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// RAIL v3 suite — the living grid + prompt-bar Moshi contract
async function railSuite(page, cand) {
  const TB = 64;
  const lanes = await page.evaluate(() => {
    const r = document.querySelector(".lanes").getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const ppb = lanes.w / TB;
  const gridAlpha = (x, y, w = 60, h = 12) => page.evaluate(([x, y, w, h]) => {
    const cv = document.querySelector(".lanes .grid"), g = cv.getContext("2d");
    const d = g.getImageData(Math.max(0, x), Math.max(0, y), w, h).data;
    let m = 0; for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]);
    return m;
  }, [Math.round(x), Math.round(y), w, h]);

  // structural
  const s = await page.evaluate(() => ({
    slab: !!document.querySelector(".slab"),
    dockTabs: document.querySelectorAll(".dtab").length,
    navSections: document.querySelectorAll(".arr-nav .section").length,
    navBeads: document.querySelectorAll(".arr-nav .bead").length,
    viewport: getComputedStyle(document.querySelector(".arr-nav .viewport")).display !== "none",
    mic: !!document.querySelector(".comp .mic"),
    moshiCanvas: !!document.querySelector("#olr-mhost canvas"),
    fallback: getComputedStyle(document.querySelector("#olr-fb")).display,
  }));
  check(cand, "slab + docks + nav structure", s.slab && s.dockTabs === 4 && s.navSections === 5 && s.navBeads === 2 && s.viewport,
    JSON.stringify({ docks: s.dockTabs, sections: s.navSections, beads: s.navBeads }));
  check(cand, "composer has NO mic icon", !s.mic);
  check(cand, "real Moshi mounted on the prompt bar", s.moshiCanvas && s.fallback === "none", `fallback:${s.fallback}`);

  // vision-panel regression: hovered rail bar (scaled 1.9x) must not clip the track name,
  // and navigator beads must not sit over section labels
  const lane0 = await page.evaluate(() => {
    const l = document.querySelector(".lane"); const r = l.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(lane0.x, lane0.y, { steps: 3 });
  await page.waitForTimeout(350); // seg scale transition
  const clipCheck = await page.evaluate(() => {
    const lane = document.querySelector(".lane");
    const seg = lane.querySelector(".seg").getBoundingClientRect();
    const name = lane.querySelector(".rname").getBoundingClientRect();
    const beads = [...document.querySelectorAll(".arr-nav .bead")].map((b) => b.getBoundingClientRect());
    const labels = [...document.querySelectorAll(".arr-nav .section > b")].map((l) => l.getBoundingClientRect());
    const hit = beads.some((b) => labels.some((l) =>
      b.left < l.right && b.right > l.left && b.top < l.bottom && b.bottom > l.top));
    return { segRight: seg.right, nameLeft: name.left, beadOverLabel: hit };
  });
  check(cand, "hovered rail bar does not clip the track name", clipCheck.segRight <= clipCheck.nameLeft + 0.5,
    `segRight:${clipCheck.segRight.toFixed(1)} nameLeft:${clipCheck.nameLeft.toFixed(1)}`);
  check(cand, "nav beads clear the section labels", !clipCheck.beadOverLabel);

  // grid reveal: invisible far away, pools near the cursor
  const cx = lanes.left + lanes.w / 2, cy = lanes.top + lanes.h / 2;
  await page.mouse.move(cx, cy, { steps: 4 });
  await page.waitForTimeout(250);
  const near = await gridAlpha(lanes.w / 2 - 30, lanes.h / 2 - 6);
  const far = await gridAlpha(4, 4);
  check(cand, "grid reveals ONLY near cursor", near > 10 && far < 9, `near:${near} far:${far}`);
  await shot(page, cand, "hover-reveal");

  // anchor-preserving snap: drums clip (data-anchor 0.12) — move anchor to beat 8
  const clip0 = await page.evaluate(() => {
    const el = document.querySelector(".clip");
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(clip0.x, clip0.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(clip0.x + 4 * ppb + 5, clip0.y, { steps: 10 }); // +4 beats, 5px jitter inside bar window
  await page.waitForTimeout(120);
  await shot(page, cand, "drag-snap");
  const leftPct = await page.evaluate(() => parseFloat(document.querySelector(".clip").style.left));
  await page.mouse.up();
  const expect = ((8 - 0.12) / 64) * 100;
  check(cand, "anchor-preserving snap (pickup stays early)", Math.abs(leftPct - expect) < 0.02, `expect ${expect.toFixed(4)}% got ${leftPct.toFixed(4)}%`);

  // ⌘ drag: snapping off + gooey whole-grid
  const clip1 = await page.evaluate(() => {
    const el = document.querySelector(".clip"); const r = el.getBoundingClientRect();
    return { x: r.left + 12, y: r.top + 8, leftBeats: parseFloat(el.style.left) / 100 * 64 };
  });
  await page.keyboard.down("Meta");
  await page.mouse.move(clip1.x, clip1.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(clip1.x + 1.37 * ppb, clip1.y, { steps: 8 });
  await page.waitForTimeout(450); // let gooT ease up
  const farGoo = await gridAlpha(4, 4);
  await shot(page, cand, "meta-goo");
  const leftMeta = await page.evaluate(() => parseFloat(document.querySelector(".clip").style.left) / 100 * 64);
  await page.mouse.up();
  await page.keyboard.up("Meta");
  check(cand, "⌘ disables snapping (raw drag)", Math.abs(leftMeta - clip1.leftBeats - 1.37) < 0.07, `moved ${(leftMeta - clip1.leftBeats).toFixed(3)} beats`);
  check(cand, "⌘ gooey grid shows whole grid", farGoo > 10, `far-corner alpha ${farGoo}`);

  // trim: bass right edge snaps to a bar (raw +3.27 → bar 36 → width 32)
  const tz = await page.evaluate(() => {
    const bass = document.querySelectorAll(".lane")[1].querySelector(".clip");
    const r = bass.querySelector(".tz").getBoundingClientRect();
    return { x: r.left + 3, y: r.top + r.height / 2 };
  });
  await page.mouse.move(tz.x, tz.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(tz.x + 3.27 * ppb, tz.y, { steps: 8 });
  await page.waitForTimeout(100);
  await shot(page, cand, "trim");
  const widthBeats = await page.evaluate(() =>
    parseFloat(document.querySelectorAll(".lane")[1].querySelector(".clip").style.width) / 100 * 64);
  await page.mouse.up();
  check(cand, "trim snaps the edge to the bar", Math.abs(widthBeats - 32) < 0.05, `width ${widthBeats.toFixed(3)} beats`);

  // selection: click clip → selc; click empty lane → cleared + lane sel
  const vox = await page.evaluate(() => {
    const el = document.querySelectorAll(".lane")[3].querySelector(".clip");
    const r = el.getBoundingClientRect(); return { x: r.left + 15, y: r.top + 10 };
  });
  await page.mouse.click(vox.x, vox.y);
  const selAfterClick = await page.evaluate(() =>
    document.querySelectorAll(".lane")[3].querySelector(".clip").classList.contains("selc"));
  await page.mouse.click(lanes.left + lanes.w - 40, lanes.top + 12); // empty drums lane area
  const clearedAfterLane = await page.evaluate(() =>
    !document.querySelector(".clip.selc") && document.querySelectorAll(".lane")[0].classList.contains("sel"));
  check(cand, "click clip selects / click lane clears", selAfterClick && clearedAfterLane, `sel:${selAfterClick} cleared:${clearedAfterLane}`);

  // hold Moshi to talk
  const mb = await page.evaluate(() => {
    const r = document.querySelector("#olr-mbtn").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
  });
  await page.mouse.move(mb.x, mb.y, { steps: 3 });
  await page.mouse.down();
  await page.waitForTimeout(400);
  const talking = await page.evaluate(() => ({
    cls: document.querySelector("#olr-compwrap").classList.contains("talk"),
    txt: document.querySelector("#olr-pht").textContent,
  }));
  await shot(page, cand, "hold-to-talk");
  await page.mouse.up();
  await page.waitForTimeout(150);
  const released = await page.evaluate(() => document.querySelector("#olr-pht").textContent);
  check(cand, "hold Moshi = talk (lime line + listening)", talking.cls && /listening/.test(talking.txt), talking.txt);
  check(cand, "release ends talk", /Ask Mosh/.test(released), released);
}

// ---------------------------------------------------------------------------
// MONUMENT v3 suite — decluttered take-loop contract
async function monumentSuite(page, cand) {
  const s = await page.evaluate(() => ({
    statusBar: !!document.querySelector(".status"),
    takeRow: !!document.querySelector(".take"),
    friendLines: !!document.querySelector(".frl"),
    caption: !!document.querySelector(".mcap"),
    regToggle: !!document.querySelector(".reg"),
    navH: document.querySelector(".arr-nav").getBoundingClientRect().height,
    beads: document.querySelectorAll(".arr-nav .bead").length,
    moshiCanvas: !!document.querySelector("#m3-mhost canvas"),
    keys: [...document.querySelectorAll(".key")].map((k) => Math.round(k.getBoundingClientRect().height)),
    mbtn: (() => { const r = document.querySelector("#m3-mbtn").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  }));
  check(cand, "clutter cut (status/take-row/friend-lines/caption/toggle)",
    !s.statusBar && !s.takeRow && !s.friendLines && !s.caption && !s.regToggle);
  check(cand, "nav in phone-hero mode + beads", s.navH === 64 && s.beads === 2, `navH:${s.navH}`);
  check(cand, "real Moshi mounted", s.moshiCanvas);
  check(cand, "hands-free hit targets (keys ≥56px, Moshi ≥150×120)",
    s.keys.every((h) => h >= 56) && s.mbtn[0] >= 150 && s.mbtn[1] >= 120, JSON.stringify({ keys: s.keys, mbtn: s.mbtn }));

  const click = async (sel) => {
    const p = await page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(80);
  };
  const state = () => page.evaluate(() => ({
    pend: document.querySelector("#m3-deck").classList.contains("pend"),
    recOn: document.querySelector("#m3-rec").classList.contains("on"),
    tn: document.querySelector("#m3-tn").textContent,
    keepOp: parseFloat(getComputedStyle(document.querySelector("#m3-keep")).opacity),
  }));

  // vision-panel regression: the verdict pair rests QUIET and only lights when pending
  const restState = await state();
  check(cand, "verdict keys dim at rest (progressive disclosure)", restState.keepOp < 0.6, `opacity ${restState.keepOp}`);

  await click("#m3-rec");
  const armed = await state();
  await shot(page, cand, "rec-armed");
  await click("#m3-stop");
  await page.waitForTimeout(400); // opacity transition
  const pending = await state();
  check(cand, "verdict keys light when pending", pending.keepOp > 0.95, `opacity ${pending.keepOp}`);
  await shot(page, cand, "verdict-pending");
  await click("#m3-keep");
  const kept = await state();
  await page.waitForTimeout(1100);
  const after = await state();
  check(cand, "take loop: arm → stop = pending rings → keep clears + increments",
    armed.recOn && !armed.pend && !pending.recOn && pending.pend && !kept.pend && after.tn === "TAKE 4",
    JSON.stringify({ armed, pending, after: after.tn }));

  // redo path
  await click("#m3-rec"); await click("#m3-stop"); await click("#m3-redo");
  const redone = await state();
  await page.waitForTimeout(1000);
  const afterRedo = await state();
  check(cand, "redo: toss + re-arm (take number unchanged)", !redone.pend && afterRedo.tn === "TAKE 4", afterRedo.tn);

  // hold Moshi
  const mb = await page.evaluate(() => {
    const r = document.querySelector("#m3-mbtn").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.55 };
  });
  await page.mouse.move(mb.x, mb.y, { steps: 3 });
  await page.mouse.down();
  await page.waitForTimeout(350);
  const on = await page.evaluate(() => document.querySelector("#m3-mbtn").classList.contains("on"));
  await shot(page, cand, "hold-to-talk");
  await page.mouse.up();
  await page.waitForTimeout(120);
  const off = await page.evaluate(() => !document.querySelector("#m3-mbtn").classList.contains("on"));
  check(cand, "hold Moshi = talk, release ends", on && off);

  // navigator scrub moves the fill
  const nav = await page.evaluate(() => {
    const r = document.querySelector(".arr-nav").getBoundingClientRect();
    return { x: r.left + r.width * 0.2, y: r.top + r.height / 2, x2: r.left + r.width * 0.7 };
  });
  await page.mouse.move(nav.x, nav.y);
  await page.mouse.down();
  await page.mouse.move(nav.x2, nav.y, { steps: 6 });
  await page.waitForTimeout(120);
  const pct = await page.evaluate(() => parseFloat(document.querySelector("#m3-fill").style.getPropertyValue("--pct")));
  await page.mouse.up();
  check(cand, "navigator scrub drives the fill", pct > 60 && pct < 80, `--pct ${pct.toFixed(1)}`);
  await shot(page, cand, "after-scrub");
}

// ---------------------------------------------------------------------------
// CLOSE-UP DRIVERS — re-drive each interaction state at 3× and capture the region
async function railCloseups(page, cand) {
  const TB = 64;
  const lanes = await page.evaluate(() => {
    const r = document.querySelector(".lanes").getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const ppb = lanes.w / TB;

  // Moshi on the prompt bar — rest (creature spills ~130px above the pill)
  const compRect = await rectOf(page, "#olr-compwrap", 140, 50);
  await closeup(page, cand, "moshi-on-bar-rest", compRect, 10);
  // Moshi — hold-to-talk (lime line, listening)
  const mb = await page.evaluate(() => {
    const r = document.querySelector("#olr-mbtn").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
  });
  await page.mouse.move(mb.x, mb.y, { steps: 3 });
  await page.mouse.down();
  await page.waitForTimeout(450);
  await closeup(page, cand, "moshi-on-bar-talk", compRect, 10);
  await page.mouse.up();
  await page.waitForTimeout(200);

  // the arrangement navigator strip
  await closeup(page, cand, "navigator", await rectOf(page, ".nav"), 10);
  // dock pull-tabs
  await closeup(page, cand, "dock-tabs", await rectOf(page, ".dock.l"), 12);

  // hovered lane: rail bar swells, name surfaces, ctl appears on the left
  const lane0 = await page.evaluate(() => {
    const r = document.querySelector(".lane").getBoundingClientRect();
    return { rect: { x: r.left - 70, y: r.top, width: r.width + 70, height: r.height }, cx: r.left + r.width * 0.6, cy: r.top + r.height / 2 };
  });
  await page.mouse.move(lane0.cx, lane0.cy, { steps: 3 });
  await page.waitForTimeout(400);
  await closeup(page, cand, "lane-hover", { ...lane0.rect, width: Math.min(lane0.rect.width, 620) }, 6);

  // clip well (waveform + machined bevel)
  await closeup(page, cand, "clip-well", await rectOf(page, ".clip"), 10);

  // mid-drag: lime emphasis line + the musical anchor tick (pickup sits early)
  const c0 = await page.evaluate(() => {
    const r = document.querySelector(".clip").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, w: r.width, top: r.top, h: r.height };
  });
  await page.mouse.move(c0.x, c0.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(c0.x + 4 * ppb + 5, c0.y, { steps: 10 });
  await page.waitForTimeout(250);
  await closeup(page, cand, "drag-snap-emphasis",
    { x: c0.left + 4 * ppb - 60, y: c0.top - 30, width: c0.w + 140, height: c0.h + 90 }, 0);
  await page.mouse.up();

  // ⌘ goo around the cursor
  await page.keyboard.down("Meta");
  const gx = lanes.left + lanes.w * 0.55, gy = lanes.top + lanes.h * 0.5;
  await page.mouse.move(gx, gy, { steps: 4 });
  await page.waitForTimeout(500);
  await closeup(page, cand, "meta-goo-detail", { x: gx - 220, y: lanes.top, width: 440, height: lanes.h }, 0);
  await page.keyboard.up("Meta");
  await page.mouse.move(lanes.left - 300, lanes.top, { steps: 2 }); // cursor away so grid doesn't muddy the shot

  // MERCURY: pin the playhead over the bass clip so the wake energy is captured
  await page.evaluate(() => { window.__mosh = window.__mosh || {}; window.__mosh.playhead = 0.30; });
  await page.waitForTimeout(220);
  const merc = await page.evaluate(() => {
    const l = document.querySelector(".lanes").getBoundingClientRect();
    const ph = document.querySelector("#olr-ph").getBoundingClientRect();
    return { x: ph.left - 160, y: l.top + l.height * 0.02, width: 320, height: l.height * 0.62 };
  });
  await closeup(page, cand, "mercury-playhead", merc, 0);
}

async function monumentCloseups(page, cand) {
  // Moshi zone — rest, then hold-to-talk (line lights)
  const mz = await rectOf(page, ".mz");
  await closeup(page, cand, "moshi-rest", mz, 6);
  const mb = await page.evaluate(() => {
    const r = document.querySelector("#m3-mbtn").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.55 };
  });
  await page.mouse.move(mb.x, mb.y, { steps: 3 });
  await page.mouse.down();
  await page.waitForTimeout(450);
  await closeup(page, cand, "moshi-talk", mz, 6);
  await page.mouse.up();
  await page.waitForTimeout(200);

  // glance header + navigator hero band
  await closeup(page, cand, "glance-header", await rectOf(page, ".glance"), 8);
  await closeup(page, cand, "nav-hero", await rectOf(page, ".nav"), 8);

  // deck at REST (verdict pair deliberately dimmed)
  await closeup(page, cand, "deck-rest", await rectOf(page, "#m3-deck"), 8);

  const click = async (sel) => {
    const p = await page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
  };
  // armed
  await click("#m3-rec");
  await closeup(page, cand, "rec-armed", await rectOf(page, ".row-transport"), 8);
  // pending: verdict pair lights + KEEP ring pulses
  await click("#m3-stop");
  await page.waitForTimeout(450);
  await closeup(page, cand, "deck-pending", await rectOf(page, "#m3-deck"), 8);
  // keep flash
  await click("#m3-keep");
  await page.waitForTimeout(200);
  await closeup(page, cand, "keep-flash", await rectOf(page, ".row-verdict"), 8);
}

// ---------------------------------------------------------------------------
// SEQUENCER suite — the loop-first "lane IS the editor" contract (uses the read-only
// window.__seq test hook). Drum toggle / MIDI add-remove-resize / audio split / zoom /
// viewport scroll / Shift-fader / right-panel / hold-Moshi.
async function sequencerSuite(page, cand) {
  const rect = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
  const paint = (sel) => page.evaluate((s) => { const cv = document.querySelector(s); const g = cv.getContext("2d"); const d = g.getImageData(0, 0, Math.min(cv.width, 400), Math.min(cv.height, 80)).data; let m = 0; for (let i = 3; i < d.length; i += 4) m = Math.max(m, d[i]); return m; }, sel);
  const focusLane = async (i) => { const r = await rect(`.lane[data-i="${i}"]`); await page.mouse.click(r.x + 40, r.y + 14); await page.waitForTimeout(440); };

  const s = await page.evaluate(() => ({
    lanes: document.querySelectorAll(".lane").length,
    zoom: document.querySelectorAll(".zoom b").length,
    docks: document.querySelectorAll(".dtab").length,
    hook: !!window.__seq,
    focus: window.__seq ? window.__seq.focus : -1,
    expandAll: window.__seq ? window.__seq.expandAll : false,
    heights: [...document.querySelectorAll(".lane")].map((l) => Math.round(l.getBoundingClientRect().height)),
    phs: document.querySelectorAll(".lane .ph").length,
    moshi: !!document.querySelector("#sq-mhost canvas"),
    fallback: getComputedStyle(document.querySelector("#sq-fb")).display,
  }));
  check(cand, "4 lanes + zoom(3) + docks(4) + hook", s.lanes === 4 && s.zoom === 3 && s.docks === 4 && s.hook, JSON.stringify({ lanes: s.lanes }));
  check(cand, "fill-all: a simple song expands EVERY lane to an editable height", s.expandAll && s.heights.length === 4 && s.heights.every((h) => h >= 110 && h <= 200) && s.phs === 4, JSON.stringify({ expandAll: s.expandAll, heights: s.heights }));
  const drumPaint = await paint('.lane[data-i="0"] .ed canvas'), miniPaint = await paint(".mini canvas");
  check(cand, "focused drum grid + minimap painted", drumPaint > 10 && miniPaint > 10, JSON.stringify({ drum: drumPaint, mini: miniPaint }));
  check(cand, "real Moshi mounted on the prompt bar", s.moshi && s.fallback === "none", `fallback:${s.fallback}`);
  await shot(page, cand, "rest");

  // R14 — chrome-OFF lanes: no color dot; a COMPACT lane hides its name + controls at rest (content carries the hue),
  // reveals them on hover, and content runs edge-to-edge; the FOCUSED lane shows its name.
  const restChrome = await page.evaluate(() => {
    const compact = document.querySelector('.lane[data-i="2"]'), focused = document.querySelector(".lane.focus");
    const op = (el, sel) => (el && el.querySelector(sel)) ? +getComputedStyle(el.querySelector(sel)).opacity : -1;
    const ed = compact.querySelector(".ed");
    return {
      hasDot: !!document.querySelector(".lane .lhead .dot"),
      compactNameOp: op(compact, ".nm"), compactCtlOp: op(compact, ".lctl"), focusedNameOp: op(focused, ".nm"),
      edLeft: Math.round(ed.getBoundingClientRect().left - compact.getBoundingClientRect().left),
    };
  });
  check(cand, "chrome-off: no color dot + compact name/controls hidden at rest", !restChrome.hasDot && restChrome.compactNameOp < 0.1 && restChrome.compactCtlOp < 0.1, JSON.stringify(restChrome));
  check(cand, "chrome-off: content runs edge-to-edge", restChrome.edLeft <= 2, `edLeft ${restChrome.edLeft}`);
  check(cand, "chrome-off: names stay hidden until hover (even when expanded)", restChrome.focusedNameOp < 0.1 && restChrome.compactNameOp < 0.1, `focused ${restChrome.focusedNameOp} · compact ${restChrome.compactNameOp}`);
  const hv = await rect('.lane[data-i="2"]');
  await page.mouse.move(hv.x + hv.w * 0.5, hv.y + hv.h * 0.5); await page.waitForTimeout(450);   // clear the 200ms reveal transition with margin
  const hover = await page.evaluate(() => { const l = document.querySelector('.lane[data-i="2"]'); return { nm: +getComputedStyle(l.querySelector(".nm")).opacity, ctl: +getComputedStyle(l.querySelector(".lctl")).opacity }; });
  check(cand, "chrome-off: hover reveals name + controls", hover.nm > 0.9 && hover.ctl > 0.9, JSON.stringify(hover));
  await page.mouse.move(6, 6); await page.waitForTimeout(120);   // move away → back to at-rest for later steps

  // DRUM toggle (drums focused by default)
  const dl = await rect('.lane[data-i="0"] .ed');
  const b0 = await page.evaluate(() => window.__seq.dpat[0].join(""));
  await page.mouse.click(dl.x + dl.w * 0.4, dl.y + dl.h * 0.12);
  const a0 = await page.evaluate(() => window.__seq.dpat[0].join(""));
  let diff = 0; for (let i = 0; i < b0.length; i++) if (b0[i] !== a0[i]) diff++;
  check(cand, "drum cell toggles (exactly one step)", diff === 1, `changed ${diff}`);
  await shot(page, cand, "drum-edit");

  // ACCORDION: click a compact lane (BASS, i=1) → focuses + expands
  await focusLane(1);
  const f1 = await page.evaluate(() => ({ focus: window.__seq.focus, h: Math.round(document.querySelector('.lane[data-i="1"]').getBoundingClientRect().height) }));
  check(cand, "clicking a lane makes it the active/edited one", f1.focus === 1 && f1.h > 110, JSON.stringify(f1));
  await shot(page, cand, "focus-bass");

  // MIDI add (top empty row) then remove — BASS now focused
  const n0 = await page.evaluate(() => document.querySelectorAll('.lane[data-i="1"] .note').length);
  const bl = await rect('.lane[data-i="1"] .ed');
  await page.mouse.click(bl.x + bl.w * 0.5, bl.y + bl.h * 0.05);
  const n1 = await page.evaluate(() => document.querySelectorAll('.lane[data-i="1"] .note').length);
  const nb = await page.evaluate(() => { const ns = document.querySelectorAll('.lane[data-i="1"] .note'); const el = ns[ns.length - 1]; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(nb.x, nb.y);
  const n2 = await page.evaluate(() => document.querySelectorAll('.lane[data-i="1"] .note').length);
  check(cand, "MIDI click adds then removes a note", n1 === n0 + 1 && n2 === n1 - 1, `${n0}->${n1}->${n2}`);

  // MIDI resize
  const rz = await page.evaluate(() => { const el = document.querySelector('.lane[data-i="1"] .note'); const r = el.querySelector(".rz").getBoundingClientRect(); return { x: r.left + 2, y: r.top + r.height / 2, idx: +el.dataset.idx }; });
  const len0 = await page.evaluate((i) => window.__seq.tracks[1].notes[i].len, rz.idx);
  await page.mouse.move(rz.x, rz.y); await page.mouse.down(); await page.mouse.move(rz.x + 40, rz.y, { steps: 6 }); await page.mouse.up();
  const len1 = await page.evaluate((i) => window.__seq.tracks[1].notes[i].len, rz.idx);
  check(cand, "MIDI note resizes by its edge", len1 > len0, `len ${len0}->${len1}`);

  // FOCUS an audio lane (VOCAL LEAD i=2) → split
  await focusLane(2);
  const d0 = await page.evaluate(() => document.querySelectorAll('.lane[data-i="2"] .divd').length);
  const vl = await rect('.lane[data-i="2"] .ed');
  await page.mouse.click(vl.x + vl.w * 0.5, vl.y + vl.h * 0.5);
  const d1 = await page.evaluate(() => document.querySelectorAll('.lane[data-i="2"] .divd').length);
  check(cand, "AUDIO click adds a split divider", d1 === d0 + 1, `${d0}->${d1}`);

  // ZOOM
  await page.click('.zoom b[data-w="16"]');
  const winW = await page.evaluate(() => document.querySelector("#sq-win").style.width);
  check(cand, "zoom 16 sets the window to 50%", winW === "50%", `win ${winW}`);
  await shot(page, cand, "zoom-16");

  // viewport drag scrolls
  const st0 = await page.evaluate(() => window.__seq.win.start);
  const w = await rect("#sq-win");
  await page.mouse.move(w.x + w.w / 2, w.y + w.h / 2); await page.mouse.down(); await page.mouse.move(w.x + w.w / 2 - 120, w.y + w.h / 2, { steps: 6 }); await page.mouse.up();
  const st1 = await page.evaluate(() => window.__seq.win.start);
  check(cand, "navigator viewport drag scrolls the window", st1 !== st0, `start ${st0}->${st1}`);

  // SHIFT fader
  await page.keyboard.down("Shift");
  await page.waitForTimeout(150);
  const fOn = await page.evaluate(() => window.__seq.faders);
  await shot(page, cand, "fader-mode");
  const fl = await rect('.lane[data-i="0"] .fader');
  const v0 = await page.evaluate(() => window.__seq.tracks[0].vol);
  await page.mouse.move(fl.x + fl.w * 0.3, fl.y + fl.h / 2); await page.mouse.down(); await page.mouse.move(fl.x + fl.w * 0.6, fl.y + fl.h / 2, { steps: 6 }); await page.mouse.up();
  const v1 = await page.evaluate(() => window.__seq.tracks[0].vol);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(120);
  const fOff = await page.evaluate(() => window.__seq.faders);
  check(cand, "Shift-hold volume fader (drag sets, release exits)", fOn && Math.abs(v1 - v0) > 0.05 && !fOff, `vol ${v0.toFixed(2)}->${v1.toFixed(2)}`);

  // right panel
  await page.click("#sq-insp");
  await page.waitForTimeout(320);
  const panel = await page.evaluate(() => document.querySelector("#sq-rpanel").classList.contains("open"));
  check(cand, "INSPECT opens the right settings panel", panel, `open:${panel}`);
  await shot(page, cand, "panel-open");

  // hold Moshi
  const mb = await page.evaluate(() => { const r = document.querySelector("#sq-mbtn").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }; });
  await page.mouse.move(mb.x, mb.y, { steps: 3 }); await page.mouse.down(); await page.waitForTimeout(300);
  const talk = await page.evaluate(() => ({ cls: document.querySelector("#sq-compwrap").classList.contains("talk"), txt: document.querySelector("#sq-pht").textContent }));
  await page.mouse.up();
  check(cand, "hold Moshi = talk (listening)", talk.cls && /listening/.test(talk.txt), talk.txt);

  // R19: drag a lane by its grip to REORDER tracks
  const gpos = await page.evaluate(() => { const l = document.querySelector('.lane[data-i="0"]'); const gr = l.querySelector(".grip"); const b = gr.getBoundingClientRect(), lb = l.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, laneH: lb.height }; });
  const order0 = await page.evaluate(() => window.__seq.order.slice());
  await page.mouse.move(gpos.x, gpos.y); await page.waitForTimeout(160);   // hover reveals + enables the grip
  await page.mouse.down();
  await page.mouse.move(gpos.x, gpos.y + gpos.laneH * 1.4, { steps: 10 }); await page.waitForTimeout(60);
  await page.mouse.up(); await page.waitForTimeout(160);
  const order1 = await page.evaluate(() => window.__seq.order.slice());
  check(cand, "drag a lane's grip reorders the tracks", JSON.stringify(order0) !== JSON.stringify(order1) && order1[0] !== order0[0] && order1.length === 4, `${order0.join("·")} → ${order1.join("·")}`);

  // R19: transport play/pause (drives the background slow-mo)
  const p0 = await page.evaluate(() => window.__seq.playing);
  await page.click("#sq-stop"); await page.waitForTimeout(80);
  const p1 = await page.evaluate(() => window.__seq.playing);
  await page.click("#sq-play"); await page.waitForTimeout(80);
  const p2 = await page.evaluate(() => window.__seq.playing);
  check(cand, "transport play/pause toggles (drives the bg slow-mo)", p0 === true && p1 === false && p2 === true, `${p0}→${p1}→${p2}`);
}

async function sequencerCloseups(page, cand) {
  const rect = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }, sel);
  const focusLane = async (i) => { const r = await page.evaluate((i) => { const el = document.querySelector(`.lane[data-i="${i}"]`); const b = el.getBoundingClientRect(); return { x: b.left, y: b.top }; }, i); await page.mouse.click(r.x + 40, r.y + 14); await page.waitForTimeout(440); };
  await closeup(page, cand, "drum-grid", await rect('.lane[data-i="0"] .ed'), 8);      // drums focused by default
  await closeup(page, cand, "compact-lanes", await rect('.lane[data-i="2"]'), 8);       // a compact preview lane
  await focusLane(1);
  await closeup(page, cand, "piano-roll", await rect('.lane[data-i="1"] .ed'), 8);
  await focusLane(2);
  await closeup(page, cand, "waveform-lane", await rect('.lane[data-i="2"] .ed'), 8);
  await closeup(page, cand, "arrangement-minimap", await rect(".mini"), 10);
  const comp = await page.evaluate(() => { const r = document.querySelector("#sq-compwrap").getBoundingClientRect(); return { x: r.left - 40, y: r.top - 140, width: r.width + 80, height: r.height + 150 }; });
  await closeup(page, cand, "moshi-on-bar-rest", comp, 10);
  await page.keyboard.down("Shift"); await page.waitForTimeout(220);
  await closeup(page, cand, "fader-mode", await rect(".lanes"), 8);
  await page.keyboard.up("Shift");
}

main().catch((e) => { console.error(e); process.exit(2); });
