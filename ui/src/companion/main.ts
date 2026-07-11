// Mosh phone controller — the DAWN single-pad + arrangement navigator, wired to the Mosh
// companion server. Pure logic lives in commandMap/navMath/layout (unit-tested); this file is
// the thin DOM shell: build, poll, render, and translate taps/drags into command plans.

import { planFor, seekPlan, targetTrackId } from "./commandMap";
import * as nav from "./navMath";
import * as L from "./layout";
import { CompanionNet, parsePairing } from "./net";
import type { Button, Snap } from "./types";

const BTN_META: Record<Button, { label: string; sub: string; cls: string }> = {
  record: { label: "PUT ME IN", sub: "record at cursor", cls: "rec" },
  keep: { label: "KEEP", sub: "stash · roll again", cls: "keep" },
  again: { label: "AGAIN", sub: "redo the take", cls: "again" },
  hear: { label: "HEAR IT", sub: "play back", cls: "hear" },
  marker: { label: "MARKER", sub: "flag this moment", cls: "marker" },
  stop: { label: "STOP", sub: "", cls: "stop" },
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const el = (tag: string, cls?: string, html?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

let net: CompanionNet | null = null;
let snap: Snap | null = null;
let layout: L.Layout = L.parse(null);
let editing = false;
let draggingNav = false;
let lastSeekAt = 0;

function toast(msg: string) {
  $("#toast").textContent = msg;
}

function bannerState(s: Snap | null): "REC" | "PLAY" | "PAUSED" {
  const t = s?.transport;
  return t?.recording ? "REC" : t?.playing ? "PLAY" : "PAUSED";
}

// ---------- pad ----------
// Tiles are created ONCE and reused; reordering moves the same DOM nodes so a FLIP
// animation can slide them to their new slots (iOS icon-rearrange feel).
function ensureTiles() {
  const grid = $("#pad");
  for (const id of L.TILES) {
    if (grid.querySelector(`.tile[data-id="${id}"]`)) continue;
    const m = BTN_META[id];
    const tile = el("button", `tile ${m.cls}`) as HTMLButtonElement;
    tile.dataset.id = id;
    tile.innerHTML = `<span class="lbl">${m.label}</span>${m.sub ? `<span class="sub">${m.sub}</span>` : ""}`;
    tile.addEventListener("click", () => {
      if (!editing) void press(id as Button);
    });
    attachTileDrag(tile, id);
    grid.appendChild(tile);
  }
}

function renderPad() {
  ensureTiles();
  $("#pad").classList.toggle("editing", editing);
  applyOrder(false);
}

/** Order the existing tiles per layout.order; when `animate`, FLIP them to new slots. */
function applyOrder(animate: boolean) {
  const grid = $("#pad");
  const tiles = Array.from(grid.querySelectorAll<HTMLElement>(".tile"));
  const first = new Map<string, DOMRect>();
  if (animate) for (const t of tiles) first.set(t.dataset.id!, t.getBoundingClientRect());

  for (const id of layout.order) {
    const t = grid.querySelector<HTMLElement>(`.tile[data-id="${id}"]`);
    if (t) {
      t.style.gridColumn = `span ${L.SPAN[id]}`;
      grid.appendChild(t); // re-append in order → grid reflows
    }
  }

  if (animate) playFlip(tiles, first, dragEl); // the lifted tile follows the finger, not the grid
}

async function press(id: Button) {
  if (!net) return;
  const plan = planFor(id, snap);
  if (plan.blockedReason) return toast(plan.blockedReason);
  const r = await net.runPlan(plan).catch((e: Error) => ({ ok: false, note: e.message }));
  toast(r.ok ? BTN_META[id].label.toLowerCase() : r.note || "failed");
  void refresh();
}

// ---------- navigator ----------
function renderNav() {
  const bar = $("#nav");
  const length = nav.songLength(snap);
  const tempo = snap?.session?.tempo ?? 120;
  const tsNum = snap?.session?.timeSigNumerator ?? 4;
  const trackId = targetTrackId(snap);
  const regions = nav.regionRects(nav.regionsForTrack(snap, trackId), length);
  const ticks = nav.barTicks(length, tempo, tsNum);
  const pos = snap?.transport?.position ?? 0;

  const regionHtml = regions
    .map((r) => `<div class="region" style="left:${r.left * 100}%;width:${r.width * 100}%"></div>`)
    .join("");
  const tickHtml = ticks.map((f) => `<div class="tick" style="left:${f * 100}%"></div>`).join("");
  bar.innerHTML = `${regionHtml}${tickHtml}<div id="playhead"></div>`;
  if (!draggingNav) $("#playhead").style.left = `${nav.playheadFrac(pos, length) * 100}%`;
}

function navFrac(clientX: number): number {
  const r = $("#nav").getBoundingClientRect();
  return nav.clamp01((clientX - r.left) / r.width);
}
function seekTo(frac: number) {
  if (!net) return;
  const now = Date.now();
  if (now - lastSeekAt < 110) return;
  lastSeekAt = now;
  const sec = nav.fracToSec(frac, nav.songLength(snap));
  void net.runPlan(seekPlan(sec)).catch(() => {});
}

// ---------- iOS-style drag-to-rearrange (FLIP reflow) ----------
let dragEl: HTMLElement | null = null;
let lpTimer: number | undefined;

// Animate `tiles` from their captured `first` rects to their current slots (FLIP).
function playFlip(tiles: HTMLElement[], first: Map<string, DOMRect>, skip?: HTMLElement | null) {
  requestAnimationFrame(() => {
    for (const t of tiles) {
      if (t === skip) continue;
      const f = first.get(t.dataset.id!);
      if (!f) continue;
      const l = t.getBoundingClientRect();
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      if (!dx && !dy) continue;
      t.style.transition = "none";
      t.style.transform = `translate(${dx}px,${dy}px)`;
      requestAnimationFrame(() => {
        t.style.transition = "transform .2s cubic-bezier(.2,.7,.3,1)";
        t.style.transform = "";
      });
    }
  });
}

function attachTileDrag(tile: HTMLButtonElement, id: Button) {
  tile.addEventListener("pointerdown", (e) => {
    if (!editing) {
      lpTimer = window.setTimeout(() => setEditing(true), 500); // long-press → edit mode
      const clear = () => window.clearTimeout(lpTimer);
      tile.addEventListener("pointerup", clear, { once: true });
      tile.addEventListener("pointermove", clear, { once: true });
      return;
    }
    e.preventDefault();
    try {
      tile.setPointerCapture(e.pointerId);
    } catch {
      /* not an active pointer (e.g. synthetic events) — drag still works */
    }
    dragEl = tile;
    const rect = tile.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;

    // Lift the tile out of the grid (position:fixed) so the others reflow into the gap.
    tile.classList.add("dragging");
    Object.assign(tile.style, {
      position: "fixed",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      zIndex: "20",
    });
    applyOrder(true); // remaining tiles slide to fill the gap

    const move = (ev: PointerEvent) => {
      tile.style.left = `${ev.clientX - grabX}px`;
      tile.style.top = `${ev.clientY - grabY}px`;
      const under = document
        .elementsFromPoint(ev.clientX, ev.clientY)
        .find((n) => n instanceof HTMLElement && n.dataset.id && n !== tile) as HTMLElement | undefined;
      if (under?.dataset.id) {
        const toIndex = layout.order.indexOf(under.dataset.id as Button);
        if (toIndex >= 0 && toIndex !== layout.order.indexOf(id)) {
          layout = { ...layout, order: L.moveInOrder(layout.order, id, toIndex) };
          applyOrder(true); // reflow the others under the finger
        }
      }
    };

    const up = () => {
      tile.removeEventListener("pointermove", move);
      const grid = $("#pad");
      const tiles = Array.from(grid.querySelectorAll<HTMLElement>(".tile"));
      const first = new Map<string, DOMRect>();
      for (const t of tiles) first.set(t.dataset.id!, t.getBoundingClientRect());
      // Drop the tile back into the flow; FLIP everyone from `first` to final slots.
      tile.classList.remove("dragging");
      Object.assign(tile.style, { position: "", width: "", height: "", left: "", top: "", zIndex: "" });
      dragEl = null;
      playFlip(tiles, first);
      L.save(localStorage, layout);
    };

    tile.addEventListener("pointermove", move);
    tile.addEventListener("pointerup", up, { once: true });
    tile.addEventListener("pointercancel", up, { once: true });
  });
}

function setEditing(v: boolean) {
  editing = v;
  document.body.classList.toggle("editing", v);
  toast(v ? "arrange your buttons — done when finished" : "");
  renderPad();
}

// ---------- poll / render ----------
function render() {
  const st = bannerState(snap);
  document.body.dataset.state = st;
  $("#stateTxt").textContent = st === "REC" ? "RECORDING" : st === "PLAY" ? "PLAYING" : "PAUSED";
  const pos = snap?.transport?.position ?? 0;
  const tempo = snap?.session?.tempo ?? 120;
  $("#sub").innerHTML = `bar ${nav.secToBar(pos, tempo).toFixed(1)}<br>mosh live`;
  renderNav();
}

async function refresh() {
  if (!net) return;
  try {
    snap = await net.snapshot();
    render();
  } catch (e) {
    toast((e as Error).message);
  }
}

// ---------- boot ----------
function buildDom() {
  const app = $("#app");
  app.innerHTML = `
    <div id="top">
      <div id="banner"><div id="stateTxt">PAUSED</div><div id="sub">connecting…</div></div>
      <button id="editBtn" title="arrange">✎</button>
    </div>
    <div id="navWrap"><div id="nav"><div id="playhead"></div></div></div>
    <div id="pad"></div>
    <div id="editbar"><button id="navPosBtn">nav: bottom</button><span class="hint">drag tiles to rearrange</span><button id="resetBtn">reset</button><button id="doneBtn">done</button></div>
    <div id="toast"></div>`;
  applyNavPos();
  $("#editBtn").addEventListener("click", () => setEditing(!editing));
  $("#doneBtn").addEventListener("click", () => setEditing(false));
  $("#resetBtn").addEventListener("click", () => {
    layout = L.parse(null);
    applyNavPos();
    renderPad();
    L.save(localStorage, layout);
  });
  $("#navPosBtn").addEventListener("click", () => {
    layout = { ...layout, navPos: layout.navPos === "bottom" ? "top" : "bottom" };
    applyNavPos();
    L.save(localStorage, layout);
  });
  const bar = $("#nav");
  bar.addEventListener("pointerdown", (e) => {
    if (editing) return;
    draggingNav = true;
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const f = navFrac(e.clientX);
    $("#playhead").style.left = `${f * 100}%`;
    seekTo(f);
  });
  bar.addEventListener("pointermove", (e) => {
    if (!draggingNav) return;
    const f = navFrac(e.clientX);
    $("#playhead").style.left = `${f * 100}%`;
    seekTo(f);
  });
  bar.addEventListener("pointerup", (e) => {
    if (!draggingNav) return;
    draggingNav = false;
    lastSeekAt = 0;
    seekTo(navFrac(e.clientX));
  });
}

function applyNavPos() {
  $("#navWrap").style.order = layout.navPos === "top" ? "-1" : "2";
  $("#pad").style.order = "1";
  const b = document.querySelector<HTMLButtonElement>("#navPosBtn");
  if (b) b.textContent = `nav: ${layout.navPos}`;
}

function boot() {
  buildDom();
  layout = L.load(localStorage);
  applyNavPos();
  renderPad();
  try {
    net = new CompanionNet(parsePairing(location.href));
  } catch (e) {
    $("#sub").textContent = (e as Error).message;
    return;
  }
  void refresh();
  window.setInterval(() => void refresh(), 160);
}

boot();
