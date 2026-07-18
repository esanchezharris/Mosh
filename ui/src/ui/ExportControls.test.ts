// G1: export range/section + delay-tail policy. ExportControls stays the ONE
// export entry-point definition (shared by the topbar popover + the redesign "+"
// file/options control) — every render is the export_audio command on the seam.
// These specs assert the exact args object exec() receives for each control
// combination, including that the default selection is byte-for-byte the pre-G1
// call (no range/tail keys at all).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportControls } from "./ExportControls";
import { useStore } from "../store";
import type { CommandResult, Snapshot, Transport } from "../types";

function transport(overrides: Partial<Transport> = {}): Transport {
  return { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0, ...overrides };
}

function snapshotWithSections(
  sections: Snapshot["sections"],
  session: Partial<Snapshot["session"]> = {},
): Snapshot {
  return { schemaVersion: 1, session: { tempo: 120, ...session }, tracks: [], sections } as unknown as Snapshot;
}

describe("ExportControls — export range (invariant 78) + delay-tail policy (invariant 81)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true, command: "export_audio", data: { file: "/mock/mixdown.wav" } }) as CommandResult);
    useStore.setState({ exec, transport: transport() });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render() {
    await act(async () => {
      root.render(React.createElement(ExportControls, { audioEnabled: true }));
    });
  }

  function select(testid: string, value: string) {
    const el = host.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function setNumber(testid: string, value: number) {
    const el = host.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function clickExport() {
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="export-run"]')!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {}); // flush the async onExport continuation
  }

  it("default selection passes NO range/tail keys — byte-for-byte the pre-G1 call", async () => {
    await render();
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24 });
  });

  it("Range=Custom with start/end passes {range:'custom', start, end}", async () => {
    await render();
    select("export-range", "custom");
    setNumber("export-start", 1);
    setNumber("export-end", 3);
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24, range: "custom", start: 1, end: 3 });
  });

  it("Range=Loop reads the store's transport.loopStart/loopEnd (not sent as args — the native side reads live loop state)", async () => {
    useStore.setState({ transport: transport({ loopStart: 0.5, loopEnd: 2.5 }) });
    await render();
    const rangeSelect = host.querySelector<HTMLSelectElement>('[data-testid="export-range"]')!;
    const loopOption = Array.from(rangeSelect.options).find((o) => o.value === "loop")!;
    expect(loopOption.disabled).toBe(false);
    select("export-range", "loop");
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24, range: "loop" });
  });

  it("the Loop option is disabled when no loop region is set", async () => {
    await render();
    const rangeSelect = host.querySelector<HTMLSelectElement>('[data-testid="export-range"]')!;
    const loopOption = Array.from(rangeSelect.options).find((o) => o.value === "loop")!;
    expect(loopOption.disabled).toBe(true);
  });

  it("Tail=Include passes {tail:'include', tailSeconds}", async () => {
    await render();
    select("export-tail", "include");
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24, tail: "include", tailSeconds: 2 });
  });

  it("Tail=Include honors a custom tailSeconds value", async () => {
    await render();
    select("export-tail", "include");
    setNumber("export-tail-seconds", 5.5);
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24, tail: "include", tailSeconds: 5.5 });
  });

  it("Range=Custom + Tail=Include compose into one call", async () => {
    await render();
    select("export-range", "custom");
    setNumber("export-start", 0);
    setNumber("export-end", 1);
    select("export-tail", "include");
    setNumber("export-tail-seconds", 2);
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", {
      format: "wav", bitDepth: 24, range: "custom", start: 0, end: 1, tail: "include", tailSeconds: 2,
    });
  });

  it("Tail=Cut (the default) never sends tail/tailSeconds keys", async () => {
    await render();
    select("export-tail", "include");   // flip away…
    select("export-tail", "cut");       // …and back to the default
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24 });
  });
});

describe("ExportControls — export-to-section (CONF-EXPORT-SECTION)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true, command: "export_audio", data: { file: "/mock/mixdown.wav" } }) as CommandResult);
    useStore.setState({ exec, transport: transport() });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render() {
    await act(async () => {
      root.render(React.createElement(ExportControls, { audioEnabled: true }));
    });
  }

  function select(testid: string, value: string) {
    const el = host.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function clickExport() {
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="export-run"]')!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {}); // flush the async onExport continuation
  }

  it("no sections defined: the Section option is disabled and the picker stays hidden", async () => {
    useStore.setState({ snapshot: snapshotWithSections([]) });
    await render();
    const rangeSelect = host.querySelector<HTMLSelectElement>('[data-testid="export-range"]')!;
    const sectionOption = Array.from(rangeSelect.options).find((o) => o.value === "section")!;
    expect(sectionOption.disabled).toBe(true);
    expect(sectionOption.textContent).toContain("none defined");
    expect(host.querySelector('[data-testid="export-section"]')).toBeNull();
  });

  it("resolves the picked section (beats @ 120bpm) to a custom seconds range on export", async () => {
    useStore.setState({
      snapshot: snapshotWithSections([
        { id: "sec-1", name: "Intro", startBeat: 0, endBeat: 16 },
        { id: "sec-2", name: "Hook", startBeat: 16, endBeat: 32 },
      ]),
    });
    await render();
    select("export-range", "section");
    select("export-section", "sec-2");
    await clickExport();
    // 120bpm -> 0.5s/beat: beats [16,32) -> seconds [8,16)
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24, range: "custom", start: 8, end: 16 });
  });

  it("defaults to the first section when none has been explicitly picked yet", async () => {
    useStore.setState({
      snapshot: snapshotWithSections([
        { id: "sec-1", name: "Intro", startBeat: 0, endBeat: 8 },
        { id: "sec-2", name: "Hook", startBeat: 8, endBeat: 24 },
      ]),
    });
    await render();
    select("export-range", "section");
    const sectionSelect = host.querySelector<HTMLSelectElement>('[data-testid="export-section"]')!;
    expect(sectionSelect.value).toBe("sec-1");
    await clickExport();
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24, range: "custom", start: 0, end: 4 });
  });

  it("honors the project tempo + time signature when resolving beats to seconds", async () => {
    useStore.setState({
      snapshot: snapshotWithSections(
        [{ id: "sec-1", name: "Verse", startBeat: 8, endBeat: 16 }],
        { tempo: 120, timeSigDenominator: 8 },
      ),
    });
    await render();
    select("export-range", "section");
    await clickExport();
    // den:8 halves the beat length vs den:4: beatSeconds = (4/8)*(60/120) = 0.25s/beat
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24, range: "custom", start: 2, end: 4 });
  });
});
