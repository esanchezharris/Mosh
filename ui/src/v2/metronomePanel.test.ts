// CAP-TRN-005 — the metronome panel through the real component, plus its pure helpers.
//
// The native --selftest proves the COMMAND's contract (partial patch, refusal, clamping,
// persistence, the non-undoable posture) and is BLIND to the audio, which is the ticket's
// point. What only a mounted component can prove is the seam in between:
//
//  • each control sends ONLY its own field — a panel that posted the whole click object
//    would look identical in every screenshot and pass every native check while quietly
//    writing back a stale render (turn on the downbeat accent, lose your level);
//  • the level slider's bounds come from the SNAPSHOT's engine clamp, not from a
//    hard-coded 0..1 — a 0..1 slider has a dead bottom fifth, because the engine
//    re-clamps to 0.2 on read;
//  • the MIDI notes stay hidden until the click is actually routed to a MIDI out, where
//    they are the only place they do anything.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetronomeControls } from "./MetronomePanel";
import {
  DEFAULT_CLICK, clickLevelDb, clickSoundLabel, clickOutputOptions,
  selectedClickOutput, isMidiClickOutput,
} from "./metronome";
import { useStore } from "../store";
import type { AudioDevices, ClickSettings, CommandResult, Snapshot } from "../types";

const CLICK: ClickSettings = {
  ...DEFAULT_CLICK,
  enabled: true, level: 0.6,
  outputDevice: "", outputDeviceResolved: "(default audio output)",
};

const AUDIO_OUT = "(default audio output)";
const MIDI_OUT = "(default MIDI output)";
const DEVICES = {
  clickOutputs: [
    { name: AUDIO_OUT, isMidi: false },
    { name: "External Headphones", isMidi: false },
    { name: MIDI_OUT, isMidi: true },
  ],
} as unknown as AudioDevices;

const sessionWith = (click: ClickSettings) =>
  ({ metronome: click.enabled, click }) as unknown as Snapshot["session"];

/** Range inputs need React's own value tracker bypassed: React skips the synthetic
 *  onChange when the node's tracked value already matches what you assigned, so a plain
 *  `el.value = x; dispatch("input")` records ZERO calls and the assertion below would be
 *  asserting nothing. (Checkboxes and selects do not need this — hence only here.) */
function dragRange(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("metronome panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const mount = (click: ClickSettings = CLICK, devices: AudioDevices | null = DEVICES) => {
    useStore.setState({
      exec, audioDevices: devices,
      loadAudioDevices: vi.fn(async () => {}) as never,
    });
    act(() => root.render(React.createElement(MetronomeControls, { session: sessionWith(click) })));
  };
  const open = () => act(() => { host.querySelector<HTMLButtonElement>('[data-testid="v2-click-more"]')!.click(); });
  const args = () => exec.mock.calls.filter((c) => c[0] === "set_metronome").map((c) => c[1]);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command } as CommandResult));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ audioDevices: null, lastError: null });
    vi.restoreAllMocks();
  });

  it("the ♩ button is still a one-click toggle, and sends nothing but `enabled`", async () => {
    // The whole point of putting the settings behind a caret: a click you have to open a
    // panel to silence is worse than the bare toggle this replaced.
    mount({ ...CLICK, enabled: true });
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Metronome"]')!.click(); });
    await flush();
    expect(args()).toEqual([{ enabled: false }]);
  });

  it("EACH control sends only its own field", async () => {
    mount();
    open();

    const emphasis = host.querySelector<HTMLInputElement>('[data-testid="v2-click-emphasis"]')!;
    act(() => { emphasis.click(); });
    await flush();
    // The exact object, not a subset: toMatchObject would pass with `level` riding along
    // from a stale render, which is precisely the bug a partial patch exists to prevent.
    expect(args()).toEqual([{ emphasizeBars: true }]);

    exec.mockClear();
    const recOnly = host.querySelector<HTMLInputElement>('[data-testid="v2-click-rec-only"]')!;
    act(() => { recOnly.click(); });
    await flush();
    expect(args()).toEqual([{ recordingOnly: true }]);

    exec.mockClear();
    const level = host.querySelector<HTMLInputElement>('[data-testid="v2-click-level"]')!;
    act(() => { dragRange(level, "0.9"); });
    await flush();
    expect(args()).toEqual([{ level: 0.9 }]);

    exec.mockClear();
    const out = host.querySelector<HTMLSelectElement>('[data-testid="v2-click-output"]')!;
    act(() => { out.value = "External Headphones"; out.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(args()).toEqual([{ outputDevice: "External Headphones" }]);
  });

  it("takes the level slider's bounds from the engine's clamp, not a hard-coded 0..1", () => {
    // getClickTrackVolume() re-clamps to [0.2, 1.0] on every READ, so a slider drawn 0..1
    // has a bottom fifth that does nothing: drag to 0, hear 0.2, watch it snap back.
    mount();
    open();
    const level = host.querySelector<HTMLInputElement>('[data-testid="v2-click-level"]')!;
    expect(level.min).toBe(String(CLICK.levelMin));
    expect(level.max).toBe(String(CLICK.levelMax));
    // Anti-vacuity: pinned against the snapshot's numbers only if those really are the
    // engine's floor/ceiling and not 0/1 by coincidence.
    expect(CLICK.levelMin).toBe(0.2);
  });

  it("says out loud that the quietest click is not silence", () => {
    mount();
    open();
    const row = host.querySelector('[data-testid="v2-click-level"]')!.closest(".v2-rec-row")!;
    expect(row.textContent).toMatch(/to silence it, turn it off/i);
  });

  it("names the device the click is REALLY going to when the stored one is absent", () => {
    // Two snapshot fields, because they genuinely differ: an interface that is unplugged
    // right now keeps its route, and the engine falls back meanwhile.
    mount({ ...CLICK, outputDevice: "Studio Interface", outputDeviceResolved: AUDIO_OUT });
    open();
    const row = host.querySelector('[data-testid="v2-click-output"]')!.closest(".v2-rec-row")!;
    expect(row.textContent).toMatch(/not available right now/i);
    expect(row.textContent).toContain(AUDIO_OUT);
    // …and the missing device stays selectable, so changing something else does not
    // silently re-point a route set on another rig.
    const values = Array.from(host.querySelectorAll<HTMLOptionElement>('[data-testid="v2-click-output"] option')).map((o) => o.value);
    expect(values).toContain("Studio Interface");
  });

  it("hides the MIDI click notes on an audio route and reveals them on a MIDI one", async () => {
    // ClickGenerator reads these notes in its midi branch ONLY — on an audio out they are
    // two dials that do nothing, which is worse than not offering them.
    mount({ ...CLICK, outputDevice: AUDIO_OUT });
    open();
    expect(host.querySelector('[data-testid="v2-click-note-big"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    mount({ ...CLICK, outputDevice: MIDI_OUT, outputDeviceResolved: MIDI_OUT });
    open();
    expect(host.querySelector('[data-testid="v2-click-note-big"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-click-note-small"]')).not.toBeNull();
  });

  it("only offers Reset on a sound that was actually replaced", () => {
    mount({ ...CLICK, soundBig: "/Users/x/click.wav", soundSmall: "" });
    open();
    expect(host.querySelector('[data-testid="v2-click-sound-big-reset"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-click-sound-small-reset"]')).toBeNull();
  });

  it("declares the same panel width to the placement hook that the CSS renders", async () => {
    // Same contract (and the same past bug) as .v2-rec-panel: useAnchoredPanel clamps the
    // panel into the viewport using the DECLARED width, so a wider stylesheet mis-places
    // it on a narrow window. jsdom applies no stylesheet, so this reads both sources.
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { readShellCss } = await import("./cssSource");
    const css = readShellCss();
    const tsx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MetronomePanel.tsx"), "utf8");
    const cssWidth = css.match(/\.v2-click-panel\s*\{[^}]*width:\s*(\d+)px/)?.[1];
    const declared = tsx.match(/useAnchoredPanel\((\d+),/)?.[1];
    expect(cssWidth, ".v2-click-panel must pin an explicit width").toBeDefined();
    expect(declared, "MetronomePanel must declare a panel width").toBeDefined();
    expect(declared).toBe(cssWidth);
  });
});

describe("metronome helpers", () => {
  it("reads the engine floor as a real, quiet level — never -inf", () => {
    expect(clickLevelDb(1)).toBe("0.0 dB");
    expect(clickLevelDb(0.2)).toBe("-14.0 dB");
    // 0 is unreachable through the command (the engine clamps), but a snapshot from a
    // future/older backend could carry it and the readout must not print "NaN dB".
    expect(clickLevelDb(0)).toBe("-inf dB");
  });

  it("calls an unset click sample 'Built-in', not empty", () => {
    expect(clickSoundLabel("")).toBe("Built-in");
    expect(clickSoundLabel("   ")).toBe("Built-in");
    expect(clickSoundLabel("/Users/x/sounds/rim.wav")).toBe("rim.wav");
  });

  it("keeps a stored-but-absent device in the list, flagged", () => {
    const opts = clickOutputOptions(
      [{ name: AUDIO_OUT, isMidi: false }], "Studio Interface", AUDIO_OUT);
    expect(opts.map((o) => o.value)).toEqual([AUDIO_OUT, "Studio Interface"]);
    expect(opts[1].label).toContain("missing");
  });

  it("falls back to the default sentinel rather than an empty picker", () => {
    // Headless / an older backend sends no clickOutputs at all; an empty <select> would
    // read as "the click has nowhere to go".
    expect(clickOutputOptions(null, "", AUDIO_OUT)).toEqual([{ value: AUDIO_OUT, label: AUDIO_OUT, isMidi: false }]);
    expect(clickOutputOptions([], "", AUDIO_OUT)).toEqual([{ value: AUDIO_OUT, label: AUDIO_OUT, isMidi: false }]);
  });

  it("shows the default sentinel when nothing was ever chosen", () => {
    expect(selectedClickOutput("", AUDIO_OUT)).toBe(AUDIO_OUT);
    expect(selectedClickOutput("  ", AUDIO_OUT)).toBe(AUDIO_OUT);
    expect(selectedClickOutput("External Headphones", AUDIO_OUT)).toBe("External Headphones");
  });

  it("recognises a MIDI destination only from the enumeration, never from the name", () => {
    const outs = [{ name: AUDIO_OUT, isMidi: false }, { name: MIDI_OUT, isMidi: true }];
    expect(isMidiClickOutput(outs, MIDI_OUT)).toBe(true);
    expect(isMidiClickOutput(outs, AUDIO_OUT)).toBe(false);
    // A device that is not in the list (unplugged) is not assumed to be MIDI.
    expect(isMidiClickOutput(outs, "Studio Interface")).toBe(false);
    expect(isMidiClickOutput(null, MIDI_OUT)).toBe(false);
  });
});
