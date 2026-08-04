// REC-001 — the recording panel through the real component.
//
// The native side proves the COMMAND's contract in --selftest (partial patch, refusal,
// persistence, the non-undoable posture). What only a mounted component can prove is the
// other half of that contract: that each control sends ONLY its own field. A panel that
// sent the whole object would look identical in every screenshot and pass every native
// check, while quietly writing back whatever it last rendered — so a producer who toggled
// punch would also un-quantise, from a stale render.
//
// And Capture's empty-handed path, which is the COMMON one (you press it having played
// nothing) and is completely invisible: no clip appears either way.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordOptionsChip, CaptureButton } from "./RecordPanel";
import { useStore } from "../store";
import type { CommandResult, RecordOptions, Snapshot } from "../types";

const OPTS: RecordOptions = {
  overdub: true, replaceExisting: false, quantize: 0.25,
  quantizeLabel: "1/4 beat", punchInOut: false, retrospectiveSeconds: 10,
};

const snapWith = (recordOptions: RecordOptions) => ({
  session: { project: { sampleRate: 44100, bitDepth: 24, timeBase: "seconds", recordOptions } },
  tracks: [], transport: {},
} as unknown as Snapshot);

describe("record options panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const mount = (opts: RecordOptions = OPTS) => {
    useStore.setState({ exec, snapshot: snapWith(opts) });
    act(() => root.render(React.createElement(RecordOptionsChip)));
  };
  const open = () => act(() => { host.querySelector<HTMLButtonElement>('[data-testid="v2-rec-opts"]')!.click(); });
  const args = () => exec.mock.calls.filter((c) => c[0] === "set_record_options").map((c) => c[1]);

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
    useStore.setState({ lastError: null });
    vi.restoreAllMocks();
  });

  it("names only what would surprise you — the default state is just 'Rec'", () => {
    // Defaults: overdub on, no quantise, no punch. Spelling those out would be three
    // words of noise on a bar that already carries six controls.
    mount({ ...OPTS, overdub: true, quantize: 0, punchInOut: false });
    expect(host.querySelector('[data-testid="v2-rec-opts"]')!.textContent).toBe("Rec");
  });

  it("names every non-default, so a take can't behave unexpectedly unannounced", () => {
    mount({ ...OPTS, overdub: false, quantize: 0.25, punchInOut: true });
    const chip = host.querySelector('[data-testid="v2-rec-opts"]')!;
    expect(chip.textContent).toContain("new take");   // a take will NOT merge
    expect(chip.textContent).toContain("grid");
    expect(chip.textContent).toContain("punch");
  });

  it("keeps the full state in the tooltip, so nothing is hidden — just not shouted", () => {
    mount({ ...OPTS, overdub: true, quantize: 0.25, quantizeLabel: "1/4 beat", punchInOut: false });
    const chip = host.querySelector('[data-testid="v2-rec-opts"]')!;
    const title = chip.getAttribute("title")!;
    expect(title).toContain("overdub");
    expect(title).toContain("1/4 beat");            // the engine's own grid name
    expect(title).toContain("punch off");
  });

  it("EACH control sends only its own field", async () => {
    mount();
    open();

    // Toggling punch must not resend overdub or quantize — the whole reason the backend
    // takes a partial patch. Asserting the exact object, not a subset: toMatchObject
    // would pass with three extra fields riding along, which is precisely the bug.
    // click(), not a synthetic "change": React routes checkbox onChange off the click,
    // so dispatching a bare change event tests nothing and silently records zero calls.
    const punch = host.querySelector<HTMLInputElement>('[data-testid="v2-rec-punch"]')!;
    act(() => { punch.click(); });
    await flush();
    expect(args()).toEqual([{ punchInOut: true }]);

    exec.mockClear();
    const quant = host.querySelector<HTMLSelectElement>('[data-testid="v2-rec-quant"]')!;
    act(() => { quant.value = "1"; quant.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(args()).toEqual([{ quantize: 1 }]);

    exec.mockClear();
    const overdub = host.querySelector<HTMLInputElement>('[data-testid="v2-rec-overdub"]')!;
    act(() => { overdub.click(); });     // OPTS has overdub on, so this turns it off
    await flush();
    expect(args()).toEqual([{ overdub: false }]);
  });

  it("offers only grids the engine implements", () => {
    mount();
    open();
    const values = Array.from(host.querySelectorAll<HTMLOptionElement>('[data-testid="v2-rec-quant"] option'))
      .map((o) => Number(o.value));
    // Every offered value must be one the backend accepts (kQuantGrids in
    // MoshOps.Record.cpp). 1/48 and 1/2-of-a-16th are the tempting-but-absent ones.
    const ENGINE_GRIDS = [0, 1 / 64, 1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 9, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 1];
    for (const v of values)
      expect(ENGINE_GRIDS.some((g) => Math.abs(g - v) <= 1e-6 * Math.max(1, g)),
        `the panel offers ${v} beats, which set_record_options would refuse`).toBe(true);
    expect(values.length).toBeGreaterThan(1);   // anti-vacuity: an empty list passes the loop
  });

  it("declares the same panel width to the placement hook that the CSS renders", async () => {
    // These two numbers live in different files and only one of them is enforced by
    // anything: useAnchoredPanel clamps the panel into the viewport using the DECLARED
    // width, so if the CSS renders wider the panel is mis-placed on a narrow window.
    // That was live for a moment — the base .v2-menu-panel rules let the hint text push
    // it to 424px against a declared 260. jsdom does not apply the stylesheet, so this
    // reads both sources rather than measuring.
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // readShellCss() rather than reading 20-topbar.css directly: it is the module that
    // already throws when a partition goes missing, so this guard cannot end up grepping
    // an empty haystack and passing.
    const { readShellCss } = await import("./cssSource");
    const css = readShellCss();
    const tsx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "RecordPanel.tsx"), "utf8");
    const cssWidth = css.match(/\.v2-rec-panel\s*\{[^}]*width:\s*(\d+)px/)?.[1];
    const declared = tsx.match(/useAnchoredPanel\((\d+),/)?.[1];
    expect(cssWidth, ".v2-rec-panel must pin an explicit width").toBeDefined();
    expect(declared, "RecordPanel must declare a panel width").toBeDefined();
    expect(declared).toBe(cssWidth);
  });

  it("warns that Replace is not undoable, because the engine's delete really is not", () => {
    mount();
    open();
    const row = host.querySelector('[data-testid="v2-rec-replace"]')!.closest(".v2-rec-row")!;
    expect(row.textContent).toMatch(/undo will not bring them back/i);
  });
});

describe("Capture MIDI button", () => {
  let host: HTMLDivElement;
  let root: Root;
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ lastError: null });
    vi.restoreAllMocks();
  });

  const press = async (result: unknown) => {
    useStore.setState({ exec: vi.fn(async () => result) as never, lastError: null });
    act(() => root.render(React.createElement(CaptureButton)));
    act(() => { host.querySelector<HTMLButtonElement>('[data-testid="v2-capture"]')!.click(); });
    await flush();
    return useStore.getState().lastError;
  };

  it("says so when there was nothing to capture", async () => {
    // ok:true with applied:false is the honest backend answer, and it is INVISIBLE —
    // no clip appears. Swallowing it makes the button look broken.
    const err = await press({ ok: true, command: "capture_midi", data: { applied: false, reason: "nothing had been played into the retrospective buffer" } });
    expect(err).toMatch(/nothing to capture/i);
    expect(err).toMatch(/retrospective buffer/i);   // the backend's own reason survives
  });

  it("stays quiet when it actually captured something", async () => {
    const err = await press({ ok: true, command: "capture_midi", data: { applied: true, clips: [{ id: "c1" }] } });
    expect(err).toBeNull();
  });

  it("surfaces a hard failure too", async () => {
    const err = await press({ ok: false, command: "capture_midi", error: "no playback context" });
    expect(err).toBe("no playback context");
  });
});
