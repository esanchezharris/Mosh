import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { Plugin, SamplerInfo, SamplerMeter, SamplerSound, Track } from "../../types";
import { SAMPLE_DND_MIME } from "../../ui/sampleBrowserUtil";
import { pluginKey } from "../../ui/tuner";
import { SUMMARY_CHARS } from "./chorus";
import {
  DEFAULT_LIMITS, dragCarriesSample, droppedSample, emptyCellCount, flashStrength, fmtLevel, fmtPan, fmtSeconds,
  freeSlotNotes, gainFromNorm, gainNorm, hitLevelDb, keyCentre, laneOf, levelKeyStep, miniDots, panFromNorm, panKeyStep,
  panNorm, peaksArea, pianoKeys, rangeText, replaceText, replacedBy, samplerSummary, sortSounds, soundFlash, viewOf,
} from "./sampler";
import { samplerPanelDef } from "./SamplerPanel";
import type { RunCommand } from "./types";

// ── fixtures: the shapes the engine sends (contract §1e) ──────────────────────────────
const sound = (o: Partial<SamplerSound> & { pitch: number }): SamplerSound => ({
  index: 0, name: "S", file: `/kits/x/${o.pitch}.wav`, path: `/kits/x/${o.pitch}.wav`, missing: false,
  minNote: o.pitch, maxNote: o.pitch, gainDb: 0, userGainDb: 0, silenced: false, pan: 0, openEnded: true,
  mode: "drum", addressNote: o.pitch, durationSec: 0.36, sampleRate: 44100, channels: 1, ...o,
});
const KIT_DEF: [string, number][] = [
  ["Kick", 36], ["Snare", 38], ["Clap", 39], ["Closed Hat", 42], ["Open Hat", 46], ["Low Tom", 45], ["Mid Tom", 47], ["Crash", 49],
];
const kit = (): SamplerSound[] => KIT_DEF.map(([name, pitch], index) => sound({ index, name, pitch }));
const melodic = (o: Partial<SamplerSound> = {}): SamplerSound => sound({
  index: 8, name: "808 Long", pitch: 24, minNote: 0, maxNote: 127, mode: "melodic", openEnded: false, addressNote: 0,
  file: "/imports/808-long.wav", path: "/imports/808-long.wav", durationSec: 1.4, ...o,
});
const samplerPlugin = (sounds: SamplerSound[], info: Partial<SamplerInfo> = {}, p: Partial<Plugin> = {}): Plugin => ({
  index: 0, name: "Sampler", type: "sampler", enabled: true, external: false, builtin: true, isInstrument: true,
  params: [], itemId: "smp1", sampler: { primary: true, sounds, limits: DEFAULT_LIMITS, ...info }, ...p,
});
const track = (o: Partial<Track> = {}): Track => ({ id: "t1", index: 0, name: "Drums", type: "drum", clips: [], ...o } as Track);

// ── the model ──────────────────────────────────────────────────────────────────────────
describe("sampler model (pure)", () => {
  it("sorts by root note, then range, then index; the view follows what is loaded", () => {
    const sorted = sortSounds([...kit()].reverse());
    expect(sorted.map((s) => s.pitch)).toEqual([36, 38, 39, 42, 45, 46, 47, 49]);
    expect(viewOf([])).toBe("empty");
    expect(viewOf(kit())).toBe("drum");
    expect(viewOf([melodic()])).toBe("melodic");
    expect(viewOf([...kit(), melodic()])).toBe("drum");                  // pads plus an 808: the grid
    expect(viewOf([sound({ pitch: 40, minNote: 36, maxNote: 47, mode: "range" })])).toBe("melodic");
  });

  it("level maps the engine's ±48 dB onto the dial, on a half-decibel grid", () => {
    expect(gainNorm(-48)).toBe(0);
    expect(gainNorm(0)).toBe(0.5);
    expect(gainNorm(48)).toBe(1);
    expect(gainNorm(60)).toBe(1);                                          // clamped like setSoundGains
    expect(gainFromNorm(0.5)).toBe(0);
    expect(Object.is(gainFromNorm(0.5), -0)).toBe(false);
    expect(gainFromNorm(0.6)).toBe(9.5);                                   // 9.6 → 9.5
    expect(gainFromNorm(0.7)).toBe(19);                                    // 19.2 → 19.0
    expect(gainFromNorm(1.2)).toBe(48);
    expect(gainFromNorm(-1)).toBe(-48);
    expect(fmtLevel(-6)).toBe("-6.0 dB");
    expect(fmtLevel(13)).toBe("+13.0 dB");
    expect(fmtLevel(-0.01)).toBe("0.0 dB");
  });

  it("pan: −1..1 on the dial, whole percent, centre is C", () => {
    expect(panNorm(-1)).toBe(0);
    expect(panNorm(0)).toBe(0.5);
    expect(panFromNorm(0.5)).toBe(0);
    expect(Object.is(panFromNorm(0.4999), -0)).toBe(false);
    expect(panFromNorm(0.625)).toBe(0.25);
    expect(fmtPan(0)).toBe("C");
    expect(fmtPan(-0.25)).toBe("L 25");
    expect(fmtPan(1)).toBe("R 100");
    expect(fmtPan(0.004)).toBe("C");
  });

  it("key steps: Level 1 dB (Shift 0.5) and 6 dB pages; Pan 5 % (Shift 1 %) and 25 % pages; Home/End are the dial's", () => {
    expect(levelKeyStep("ArrowUp", false)).toBe(1);
    expect(levelKeyStep("ArrowLeft", true)).toBe(-0.5);
    expect(levelKeyStep("PageDown", false)).toBe(-6);
    expect(levelKeyStep("Home", false)).toBeNull();
    expect(panKeyStep("ArrowRight", false)).toBe(0.05);
    expect(panKeyStep("ArrowDown", true)).toBe(-0.01);
    expect(panKeyStep("PageUp", false)).toBe(0.25);
    expect(panKeyStep("End", false)).toBeNull();
  });

  it("a hit plays at gainDb − 20·(1 − vel); the flash follows that level (−48 dB floor faint, 0 dB full)", () => {
    expect(hitLevelDb(0, 1)).toBe(0);
    expect(hitLevelDb(0, 0.5)).toBe(-10);
    expect(hitLevelDb(-6, 0.75)).toBe(-11);
    expect(hitLevelDb(0, 2)).toBe(0);                                      // velocity clamped to 1
    expect(flashStrength(-48)).toBeCloseTo(0.15, 10);
    expect(flashStrength(-60)).toBeCloseTo(0.15, 10);
    expect(flashStrength(0)).toBe(1);
    expect(flashStrength(6)).toBe(1);
    expect(flashStrength(-24)).toBeCloseTo(0.575, 10);
    expect(flashStrength(Number.NaN)).toBe(0.15);
  });

  it("a hit lights every sound covering its note (layering), the brightest hit wins", () => {
    const k = sound({ pitch: 36 }), s = sound({ pitch: 38, gainDb: -48 }), m = melodic();
    const hits = new Map([[36, { vel: 0.5 }], [38, { vel: 1 }]]);
    expect(soundFlash(k, hits)).toBeCloseTo(flashStrength(-10), 10);
    expect(soundFlash(s, hits)).toBeCloseTo(0.15, 10);                    // silenced pad: received, silent
    expect(soundFlash(m, hits)).toBeCloseTo(1, 10);                       // the 808 plays both notes; 38 is louder
    expect(soundFlash(sound({ pitch: 42 }), hits)).toBe(0);
  });

  it("lanes are keyed by the ROOT note; solo elsewhere silences the rest", () => {
    const t = track({ drumMutedPitches: [42], drumSoloPitches: [38] });
    expect(laneOf(sound({ pitch: 42 }), t)).toEqual({ muted: true, solo: false, soloedOut: false });
    expect(laneOf(sound({ pitch: 38 }), t)).toEqual({ muted: false, solo: true, soloedOut: false });
    expect(laneOf(sound({ pitch: 36 }), t)).toEqual({ muted: false, solo: false, soloedOut: true });
    expect(laneOf(sound({ pitch: 36 }), undefined)).toEqual({ muted: false, solo: false, soloedOut: false });
  });

  it("what a drop replaces is EVERY sound covering the note, an 808 across the keys too, and the text says so", () => {
    const sounds = [...kit(), melodic()];
    // The dropped-on pad first (the narrowest), then whatever else covers the note.
    expect(replacedBy(sounds, 39).map((s) => s.name)).toEqual(["Clap", "808 Long"]);
    expect(replacedBy(kit(), 40)).toEqual([]);
    const t = replaceText(replacedBy(sounds, 39), "clap909.wav");
    expect(t.title).toBe("Replace Clap with clap909.wav?");
    expect(t.detail).toBe("Level, pan and choke start over. Also removes 808 Long (all keys).");
    expect(replaceText([sound({ name: "Snare", pitch: 38 })], "x.wav").detail).toBe("Level, pan and choke start over.");
  });

  it("empty cells offer the kit's free notes first; an 808 across the keys does not take a note", () => {
    const noSnare = kit().filter((s) => s.pitch !== 38);
    expect(freeSlotNotes(noSnare, 1)).toEqual([38]);
    expect(freeSlotNotes(kit(), 2)).toEqual([37, 40]);
    expect(freeSlotNotes([melodic()], 3)).toEqual([36, 38, 39]);
    expect(freeSlotNotes(kit(), 0)).toEqual([]);
    expect(emptyCellCount(0)).toBe(8);
    expect(emptyCellCount(7)).toBe(1);
    expect(emptyCellCount(8)).toBe(0);
    expect(emptyCellCount(9)).toBe(0);
  });

  it("a drop's file: the sample browser's path first, a Finder file only with a real path", () => {
    const browser = { getData: (m: string) => (m === SAMPLE_DND_MIME ? "/s/a.wav" : ""), files: [] as File[] };
    expect(droppedSample(browser)).toEqual({ path: "/s/a.wav" });
    const withPath = Object.assign(new File([""], "b.wav"), { path: "/Users/me/b.wav" });
    expect(droppedSample({ getData: () => "", files: [withPath] })).toEqual({ path: "/Users/me/b.wav" });
    expect(droppedSample({ getData: () => "", files: [new File([""], "c.wav")] })).toEqual({ path: null, reason: "no-path" });
    expect(droppedSample({ getData: () => "", files: [] })).toEqual({ path: null, reason: "not-a-file" });
    expect(dragCarriesSample([SAMPLE_DND_MIME, "text/plain"])).toBe(true);
    expect(dragCarriesSample(["Files"])).toBe(true);
    expect(dragCarriesSample(["text/plain"])).toBe(false);
    expect(dragCarriesSample(undefined)).toBe(false);
  });

  it("the key strip: 128 keys, 75 white sharing the width, black keys straddling", () => {
    const keys = pianoKeys(0, 127, 273);
    expect(keys).toHaveLength(128);
    const whites = keys.filter((k) => !k.black);
    expect(whites).toHaveLength(75);
    const ww = 273 / 75;
    expect(keys[0]).toEqual({ note: 0, black: false, x: 0, w: ww });
    expect(keys[1]!.black).toBe(true);
    expect(keys[1]!.x).toBeCloseTo(ww - (ww * 0.6) / 2, 10);
    expect(keys[127]!.x + keys[127]!.w).toBeCloseTo(273, 10);           // G9 ends at the right edge
    expect(keyCentre(keys, 60)).toBeCloseTo(35 * ww + ww / 2, 10);        // C4 is the 36th white key
    expect(keyCentre(keys, 200)).toBeNull();
    expect(rangeText({ minNote: 0, maxNote: 127 })).toBe("all keys");
    expect(rangeText({ minNote: 36, maxNote: 36 })).toBe("C2");
    expect(rangeText({ minNote: 36, maxNote: 47 })).toBe("C2–B2");
  });

  it("the waveform is the peaks exactly: maxima across, minima back, clamped to ±1", () => {
    expect(peaksArea([[-1, 1], [-0.5, 0.5]], 10, 10)).toBe("M0 0 L10 2.5 L10 7.5 L0 10 Z");
    expect(peaksArea([[-2, 3]], 10, 10)).toBe("M5 0 L5 10 Z");
    expect(peaksArea([[0.4, -0.4]], 10, 10)).toBe("M5 3 L5 7 Z");       // min/max in either order
    expect(peaksArea([], 10, 10)).toBe("");
  });

  it("mini dots: one per sound, eight to a row", () => {
    const d = miniDots(8, 44, 14);
    expect(d).toHaveLength(8);
    expect(d[0]).toEqual({ cx: 2.75, cy: 7 });
    expect(d[7]!.cx).toBeCloseTo(41.25, 10);
    expect(miniDots(12, 44, 14).map((p) => p.cy)).toEqual([...Array(8).fill(3.5), ...Array(4).fill(10.5)]);
    expect(miniDots(0, 44, 14)).toEqual([]);
    expect(fmtSeconds(0.356)).toBe("0.36 s");
    expect(fmtSeconds(1.43)).toBe("1.4 s");
    expect(fmtSeconds(undefined)).toBe("");
  });

  it("the summary fits 16 characters and says what is loaded", () => {
    const cases: [Plugin, string][] = [
      [samplerPlugin(kit(), { kit: "mosh-kit" }), "8 pads, mosh-kit"],
      [samplerPlugin(kit()), "8 pads"],
      [samplerPlugin([sound({ pitch: 36, name: "Kick" })]), "1 pad"],
      [samplerPlugin([melodic({ name: "808", pitch: 24 })]), "808 · root C1"],
      [samplerPlugin([melodic({ name: "808 Boom", pitch: 36 })]), "808 Boom · C2"],
      [samplerPlugin([melodic({ name: "Very Long Bass Sample", pitch: 36 })]), "Very Long … · C2"],
      [samplerPlugin([...kit(), melodic({ name: "808" })]), "8 pads + 808"],
      [samplerPlugin([...kit(), melodic({ name: "808 Long Tail" })]), "8 pads + keys"],
      [samplerPlugin(kit().map((s, i) => (i === 2 ? { ...s, missing: true } : s))), "1 of 8 missing"],
      [samplerPlugin([]), "empty"],
    ];
    for (const [p, want] of cases) {
      expect(samplerSummary(p)).toBe(want);
      expect(want.length, want).toBeLessThanOrEqual(SUMMARY_CHARS);
    }
    // An engine that sends no sampler block: the plugin's own name, nothing invented.
    expect(samplerSummary({ ...samplerPlugin([]), sampler: undefined })).toBe("Sampler");
  });
});

// ── the panel ──────────────────────────────────────────────────────────────────────────
describe("Sampler panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: [string, Record<string, unknown>][];
  let refuse: Set<string>;
  let run: RunCommand;
  const results: Record<string, unknown> = {
    audition_note: { trackId: "t1", pitch: 0, action: "blip", audible: true, path: "sampler", held: 0, recordable: false },
    list_drum_kits: {
      kits: [
        { id: "mosh-kit", name: "mosh kit", pads: 8, path: "/k/mosh-kit", available: true },
        { id: "mosh-808", name: "mosh 808", pads: 8, path: "/k/mosh-808", available: true },
      ],
      defaultKit: "mosh-kit",
    },
    file_peaks: { path: "", buckets: 3, peaks: [[-0.5, 0.5], [-1, 1], [-0.2, 0.2]] },
    assign_sample: { trackId: "t1", index: 0, note: 0, name: "x", mode: "drum", file: "/imports/x.wav", sounds: 8 },
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    refuse = new Set();
    run = vi.fn(async (command: string, args: Record<string, unknown>) => {
      calls.push([command, args]);
      if (refuse.has(command)) return { ok: false, command, error: "refused" };
      return { ok: true, command, data: results[command] };
    }) as unknown as RunCommand;
    useStore.setState({ pluginMeters: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const render = (plugin: Plugin, t: Track | undefined = track()) => act(() => {
    root.render(React.createElement(samplerPanelDef.Panel, {
      plugin, trackId: "t1", track: t, sampleRate: 48000, setParam: vi.fn(), setState: vi.fn(), run,
    }));
  });
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector<E>(sel);
  const cell = (note: number) => q(`[data-testid="pp-sampler-cell"][data-note="${note}"]`)!;
  const pad = (note: number) => cell(note).querySelector<HTMLButtonElement>("button.pad")!;
  const tap = (note: number) => act(() => { pad(note).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 9 })); });
  const sent = (command: string) => calls.filter(([c]) => c === command).map(([, a]) => a);
  const dial = (id: string) => q<SVGSVGElement>(`[data-testid="${id}"] svg`)!;
  const key = (el: Element, k: string, shiftKey = false) => act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
  });
  const drop = (el: Element, dt: { types: string[]; getData: (m: string) => string; files: File[] }) => act(() => {
    for (const type of ["dragover", "drop"]) {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
      ev.dataTransfer = { ...dt, dropEffect: "none" };
      el.dispatchEvent(ev);
    }
  });
  const fromBrowser = (path: string) => ({ types: [SAMPLE_DND_MIME], getData: (m: string) => (m === SAMPLE_DND_MIME ? path : ""), files: [] });
  const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

  it("draws the loaded pads in note order (no empty bank), each with its note, name and lane state", () => {
    render(samplerPlugin(kit().reverse(), { kit: "mosh-kit" }), track({ drumMutedPitches: [42] }));
    const cells = [...host.querySelectorAll('[data-testid="pp-sampler-cell"]')];
    expect(cells.map((c) => Number(c.getAttribute("data-note")))).toEqual([36, 38, 39, 42, 45, 46, 47, 49]);
    expect(host.querySelectorAll('[data-testid="pp-sampler-slot"]')).toHaveLength(0);
    expect(cell(36).querySelector(".n")!.textContent).toBe("C2");
    expect(cell(36).querySelector(".nm")!.textContent).toBe("Kick");
    expect(cell(42).classList.contains("quiet")).toBe(true);
    expect(cell(42).querySelector('[data-testid="pp-sampler-m"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-testid="pp-sampler-kitbtn"]')!.textContent).toContain("mosh kit");
    expect(q('[data-testid="pp-sampler-row"]')).toBeNull();               // nothing selected: no row
  });

  it("a tap plays the pad (audition_note blip at its note) and selects it; nothing else is sent", async () => {
    render(samplerPlugin(kit()));
    tap(38);
    await settle();
    expect(calls).toEqual([["audition_note", { pitch: 38, velocity: 100, action: "blip" }]]);
    expect(pad(38).getAttribute("aria-current")).toBe("true");
    expect(pad(38).classList.contains("pressed")).toBe(true);           // immediate feedback
    expect(q('[data-testid="pp-sampler-row"]')!.getAttribute("data-sound")).toBe("38-38-38");
  });

  it("an audition that is not heard says why", async () => {
    results.audition_note = { ...(results.audition_note as object), audible: false, path: "none", reason: "no audio device" };
    try {
      render(samplerPlugin(kit()));
      tap(36);
      await settle();
      expect(q('[data-testid="pp-sampler-hint"]')!.textContent).toBe("Not heard: no audio device");
    } finally {
      results.audition_note = { ...(results.audition_note as object), audible: true, path: "sampler", reason: undefined };
    }
  });

  it("a Level drag previews and sends ONE set_drum_pad on release, to the sound's address note", async () => {
    render(samplerPlugin(kit()));
    tap(38);
    calls.length = 0;
    const svg = dial("pp-sampler-level");
    const frame = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    act(() => { svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 1, button: 0 })); });
    for (const y of [95, 90, 85, 80, 75, 70]) {
      act(() => { svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: y, pointerId: 1 })); });
      await frame();
    }
    expect(sent("set_drum_pad")).toEqual([]);                           // every write rebuilds the sampler: none mid-drag
    // 30 px of 150 = 0.2 of 96 dB = 19.2 → 19.0 dB, shown while dragging, and on the cell's tick.
    expect(q('[data-testid="pp-sampler-level"] .v')!.textContent).toBe("+19.0 dB");
    expect((cell(38).querySelector(".g .f") as HTMLElement).style.width).toBe(`${((19 / 96) * 100).toFixed(1)}%`);
    act(() => { svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 70, pointerId: 1 })); });
    expect(sent("set_drum_pad")).toEqual([{ note: 38, gainDb: 19 }]);
    // A press that does not move sends nothing.
    act(() => {
      svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 2, button: 0 }));
      svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 100, pointerId: 2 }));
    });
    expect(sent("set_drum_pad")).toHaveLength(1);
  });

  it("keys preview each step and send ONCE when the burst goes quiet; Pan sends pan only", () => {
    vi.useFakeTimers();
    render(samplerPlugin(kit()));
    tap(38);
    calls.length = 0;
    const lvl = dial("pp-sampler-level");
    key(lvl, "ArrowUp"); key(lvl, "ArrowUp"); key(lvl, "ArrowUp", true);
    expect(q('[data-testid="pp-sampler-level"] .v')!.textContent).toBe("+2.5 dB");
    act(() => { vi.advanceTimersByTime(399); });
    expect(sent("set_drum_pad")).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    expect(sent("set_drum_pad")).toEqual([{ note: 38, gainDb: 2.5 }]);
    const pan = dial("pp-sampler-pan");
    key(pan, "ArrowLeft"); key(pan, "ArrowLeft");
    act(() => { vi.advanceTimersByTime(400); });
    // A pan-only edit carries no gain: on a silenced pad a gain would land in its parked level.
    expect(sent("set_drum_pad")[1]).toEqual({ note: 38, pan: -0.1 });
    expect(q('[data-testid="pp-sampler-pan"] .v')!.textContent).toBe("L 10");
  });

  it("selecting another sound mid-burst still sends the burst, to the sound it was for", () => {
    vi.useFakeTimers();
    render(samplerPlugin(kit()));
    tap(38);
    key(dial("pp-sampler-level"), "PageUp");
    tap(36);
    expect(sent("set_drum_pad")).toEqual([{ note: 38, gainDb: 6 }]);
    expect(q('[data-testid="pp-sampler-row"]')!.getAttribute("data-sound")).toBe("36-36-36");
  });

  it("a silenced pad shows and edits its parked level (userGainDb), never the −48 dB floor", () => {
    vi.useFakeTimers();
    const sounds = kit().map((s) => (s.pitch === 38 ? { ...s, gainDb: -48, userGainDb: -6, silenced: true } : s));
    render(samplerPlugin(sounds), track({ drumMutedPitches: [38] }));
    tap(38);
    expect(dial("pp-sampler-level").getAttribute("aria-valuetext")).toBe("-6.0 dB (parked while silent)");
    expect(q('[data-testid="pp-sampler-status"]')!.textContent).toBe("muted");
    key(dial("pp-sampler-level"), "ArrowUp");
    act(() => { vi.advanceTimersByTime(400); });
    expect(sent("set_drum_pad")).toEqual([{ note: 38, gainDb: -5 }]);
  });

  it("a refused write lets the preview go (the snapshot's value shows again)", async () => {
    vi.useFakeTimers();
    refuse.add("set_drum_pad");
    render(samplerPlugin(kit()));
    tap(36);
    key(dial("pp-sampler-level"), "ArrowDown");
    expect(q('[data-testid="pp-sampler-level"] .v')!.textContent).toBe("-1.0 dB");
    await act(async () => { vi.advanceTimersByTime(400); for (let i = 0; i < 6; i++) await Promise.resolve(); });
    expect(q('[data-testid="pp-sampler-level"] .v')!.textContent).toBe("0.0 dB");
  });

  it("choke is a pad setting sent at once; its text never claims a live choke", () => {
    render(samplerPlugin(kit()));
    tap(42);
    const sel = q<HTMLSelectElement>('[data-testid="pp-sampler-choke"]')!;
    act(() => { sel.value = "3"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(sent("set_drum_pad")).toEqual([{ note: 42, chokeGroup: 3 }]);
    const title = sel.closest("label")!.getAttribute("title")!;
    expect(title).toMatch(/not while playing live/);
    expect(title).not.toMatch(/\bwhen playing live\b|applies (live|when playing)/i);
  });

  it("Clear removes the selected sound by its address note", async () => {
    const sounds = [...kit(), melodic()];
    render(samplerPlugin(sounds));
    tap(24);                                                              // the 808's cell: its root, played across keys
    click(q('[data-testid="pp-sampler-clear"]')!);
    await settle();
    expect(sent("clear_drum_pad")).toEqual([{ note: 0 }]);               // addressNote, not the root (a pad could own it)
    expect(q('[data-testid="pp-sampler-choke"]')).toBeNull();             // never a choke write on a melodic sound
  });

  it("M and S toggle the lane at the sound's root without playing it", () => {
    render(samplerPlugin(kit()), track({ drumSoloPitches: [38] }));
    click(cell(36).querySelector('[data-testid="pp-sampler-m"]')!);
    click(cell(38).querySelector('[data-testid="pp-sampler-s"]')!);
    expect(calls).toEqual([["set_drum_lane", { note: 36, mute: true }], ["set_drum_lane", { note: 38, solo: false }]]);
    expect(cell(36).classList.contains("quiet")).toBe(true);              // silent: another lane is soloed
  });

  it("a drop that replaces asks first; Replace sends assign_sample at the DROP TARGET's note", async () => {
    render(samplerPlugin([...kit(), melodic()]));
    tap(36);                                                              // the selection does not decide the note
    calls.length = 0;
    drop(cell(39), fromBrowser("/s/clap909.wav"));
    expect(sent("assign_sample")).toEqual([]);
    const confirm = q('[data-testid="pp-sampler-confirm"]')!;
    expect(confirm.textContent).toContain("Replace Clap with clap909.wav?");
    expect(confirm.textContent).toContain("Also removes 808 Long (all keys).");
    click(q('[data-testid="pp-sampler-replace"]')!);
    await settle();
    expect(sent("assign_sample")).toEqual([{ note: 39, file: "/s/clap909.wav", mode: "drum" }]);
    expect(q('[data-testid="pp-sampler-confirm"]')).toBeNull();
  });

  it("Cancel sends nothing; a drop on an empty cell (nothing replaced) loads at once", async () => {
    render(samplerPlugin(kit().filter((s) => s.pitch !== 38)));
    drop(cell(39), fromBrowser("/s/a.wav"));
    click(q('[data-testid="pp-sampler-cancel"]')!);
    expect(sent("assign_sample")).toEqual([]);
    const slot = q('[data-testid="pp-sampler-slot"][data-note="38"]')!;
    drop(slot, fromBrowser("/s/snare2.wav"));
    await settle();
    expect(sent("assign_sample")).toEqual([{ note: 38, file: "/s/snare2.wav", mode: "drum" }]);
  });

  it("a Finder file with no path is refused with a notice, and the timeline's drop never sees it", () => {
    const appDrop = vi.fn();
    window.addEventListener("drop", appDrop);
    try {
      render(samplerPlugin(kit()));
      drop(cell(36), { types: ["Files"], getData: () => "", files: [new File([""], "x.wav")] });
      expect(sent("assign_sample")).toEqual([]);
      expect(q('[data-testid="pp-sampler-refusal"]')!.textContent).toMatch(/Browser › Files/);
      expect(appDrop).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("drop", appDrop);
    }
  });

  it("the kit list is fetched only when the menu opens; loading one says it replaces everything", async () => {
    render(samplerPlugin(kit(), { kit: "mosh-kit" }));
    expect(sent("list_drum_kits")).toEqual([]);
    click(q('[data-testid="pp-sampler-kitbtn"]')!);
    await settle();
    expect(sent("list_drum_kits")).toEqual([{}]);
    expect(q('[data-testid="pp-sampler-kits"]')!.textContent).toContain("Replaces all 8 sounds");
    const kits = [...host.querySelectorAll('[data-testid="pp-sampler-kit"]')];
    expect(kits.map((k) => k.textContent)).toEqual(["mosh kit", "mosh 808"]);
    expect(kits[0]!.getAttribute("aria-pressed")).toBe("true");
    click(kits[1]!);
    expect(sent("load_drum_kit")).toEqual([{ kit: "mosh-808" }]);
  });

  it("rail hits flash the sounds they play, once per frame; a held frame never re-fires", () => {
    vi.useFakeTimers();
    const frame = (seq: number, hits: { note: number; vel: number }[]): SamplerMeter =>
      ({ trackId: "t1", index: 0, itemId: "smp1", type: "sampler", seq, outDb: -6, held: [], hits });
    useStore.setState({ pluginMeters: { [pluginKey("t1", 0)]: frame(1, [{ note: 36, vel: 1 }, { note: 38, vel: 0.5 }]) } });
    render(samplerPlugin([...kit(), melodic()]));
    const fl = (note: number) => Number((cell(note).querySelector(".fl") as HTMLElement).style.opacity);
    expect(fl(36)).toBe(1);
    expect(fl(38)).toBe(Number(flashStrength(-10).toFixed(2)));         // vel 0.5 at 0 dB plays at −10 dB
    expect(fl(39)).toBe(0);
    expect(fl(24)).toBe(1);                                               // the 808 covers both notes
    act(() => { vi.advanceTimersByTime(200); });
    render(samplerPlugin([...kit(), melodic()]));                          // the same frame, held on screen
    expect(fl(36)).toBe(0);
    act(() => { useStore.setState({ pluginMeters: { [pluginKey("t1", 0)]: frame(2, [{ note: 36, vel: 1 }]) } }); });
    expect(fl(36)).toBe(1);                                               // a new frame: a new hit
    // A frame from another plugin at this slot (after a reorder) lights nothing.
    act(() => { useStore.setState({ pluginMeters: { [pluginKey("t1", 0)]: { ...frame(3, [{ note: 39, vel: 1 }]), itemId: "other" } } }); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(fl(39)).toBe(0);
  });

  it("melodic: real peaks from file_peaks (once per path), the root and held keys; no choke", async () => {
    const m = melodic({ path: "/imports/808-melodic-a.wav", file: "/imports/808-melodic-a.wav", pitch: 36 });
    useStore.setState({ pluginMeters: { [pluginKey("t1", 0)]: { trackId: "t1", index: 0, itemId: "smp1", type: "sampler", seq: 4, outDb: -9, held: [43], hits: [] } } });
    render(samplerPlugin([m]));
    await settle();
    expect(q('[data-testid="pp-sampler"]')!.getAttribute("data-view")).toBe("melodic");
    expect(sent("file_peaks")).toEqual([{ path: "/imports/808-melodic-a.wav", buckets: 136 }]);
    expect(q('[data-testid="pp-sampler-peaks"]')!.getAttribute("d")).toBe(peaksArea([[-0.5, 0.5], [-1, 1], [-0.2, 0.2]], 273, 24));
    expect(q('[data-testid="pp-sampler-keys"] rect[data-note="43"]')!.getAttribute("class")).toContain("lit");
    expect(q('[data-testid="pp-sampler-keys"] rect[data-note="36"]')!.getAttribute("class")).toContain("root");
    expect(q('[data-testid="pp-sampler-keys"]')!.textContent).toBe("root C2");
    expect(q('[data-testid="pp-sampler-choke"]')).toBeNull();
    click(q('[data-testid="pp-sampler-mute"]')!);
    expect(sent("set_drum_lane")).toEqual([{ note: 36, mute: true }]);
    // The same file again (another mount): served from the cache.
    act(() => root.unmount());
    root = createRoot(host);
    render(samplerPlugin([m]));
    await settle();
    expect(sent("file_peaks")).toHaveLength(1);
    expect(q('[data-testid="pp-sampler-peaks"]')).not.toBeNull();
  });

  it("a missing (or unresolved) file shows as missing and asks for no peaks: nothing made up", async () => {
    render(samplerPlugin([melodic({ path: "/gone/808-x.wav", file: "/gone/808-x.wav", missing: true })]));
    await settle();
    expect(sent("file_peaks")).toEqual([]);
    expect(q('[data-testid="pp-sampler-peaks"]')).toBeNull();
    expect(q('[data-testid="pp-sampler-nowave"]')!.textContent).toBe("missing: 808-x.wav");
    expect(q('[data-testid="pp-sampler-status"]')!.textContent).toBe("file missing");
    render(samplerPlugin([melodic({ path: "", file: "audio/808-rel.wav" })]));
    await settle();
    expect(sent("file_peaks")).toEqual([]);
    expect(q('[data-testid="pp-sampler-nowave"]')!.textContent).toBe("808-rel.wav");
    render(samplerPlugin(kit().map((s) => (s.pitch === 39 ? { ...s, missing: true } : s))));
    expect(cell(39).classList.contains("missing")).toBe(true);
    expect(cell(39).querySelector(".n")!.textContent).toBe("missing");
  });

  it("empty: a drop asks pad or keys, then loads it", async () => {
    render(samplerPlugin([]));
    expect(q('[data-testid="pp-sampler-empty"]')!.textContent).toContain("Drop a sample or load a kit");
    drop(q('[data-testid="pp-sampler-empty"]')!, fromBrowser("/s/bass.wav"));
    expect(q('[data-testid="pp-sampler-choose"]')!.textContent).toContain("bass.wav");
    click(q('[data-testid="pp-sampler-as-keys"]')!);
    await settle();
    expect(sent("assign_sample")).toEqual([{ note: 60, file: "/s/bass.wav", mode: "melodic" }]);
    drop(q('[data-testid="pp-sampler-empty"]')!, fromBrowser("/s/kick.wav"));
    click(q('[data-testid="pp-sampler-as-pad"]')!);
    await settle();
    expect(sent("assign_sample")[1]).toEqual({ note: 36, file: "/s/kick.wav", mode: "drum" });
  });

  it("a second sampler on the track is read-only: no taps, drops, lanes or kit menu", async () => {
    render(samplerPlugin(kit(), { primary: false }));
    expect(pad(36).disabled).toBe(true);
    tap(36);
    drop(cell(38), fromBrowser("/s/a.wav"));
    await settle();
    expect(calls).toEqual([]);
    expect(host.querySelector('[data-testid="pp-sampler-m"]')).toBeNull();
    expect(q('[data-testid="pp-sampler-kitbtn"]')).toBeNull();
    expect(q('[data-testid="pp-sampler-hint"]')!.textContent).toMatch(/Read-only/);
  });

  it("an engine with no sampler block says so instead of guessing", () => {
    render({ ...samplerPlugin([]), sampler: undefined });
    expect(q('[data-testid="pp-sampler-old-engine"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="pp-sampler-cell"]')).toHaveLength(0);
  });

  it("the minimized dots light from the rail's hits", () => {
    useStore.setState({ pluginMeters: { [pluginKey("t1", 0)]: { trackId: "t1", index: 0, itemId: "smp1", type: "sampler", seq: 7, outDb: -6, held: [], hits: [{ note: 38, vel: 1 }] } } });
    act(() => {
      root.render(React.createElement(samplerPanelDef.Mini!, {
        plugin: samplerPlugin(kit()), trackId: "t1", track: track(), sampleRate: 48000, setParam: vi.fn(), setState: vi.fn(), run,
      }));
    });
    const dots = [...host.querySelectorAll('[data-testid="pp-sampler-mini"] circle')];
    expect(dots).toHaveLength(8);
    expect(dots.map((d) => d.classList.contains("lit"))).toEqual([false, true, false, false, false, false, false, false]);
  });
});
