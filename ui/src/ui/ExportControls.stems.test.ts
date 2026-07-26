// G7 — stem export in ExportControls.
//
// The backend has shipped and been natively verified for a long time (SelfTest.cpp's G7
// section proves real per-track isolation with a diff-RMS check); what was missing was any
// way for a mouse-only user to reach it.
//
// Two things here are load-bearing beyond "the button dispatches":
//
//  1. The confirm gate. export_stems runs N full renders INLINE on the message thread —
//     execute_command is not threaded the way brain_chat is — with no progress event and no
//     cancel. If a hosted plugin forces real-time rendering, every stem renders in real time.
//     So an accidental click is unrecoverable, and the click must be deliberate.
//  2. Range/Tail must not appear in stems mode. export_stems has no such args; it always
//     renders the full edit from a common zero point so the stems re-import aligned. A
//     control that is silently ignored is worse than no control.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportControls } from "./ExportControls";
import { useStore } from "../store";
import type { CommandResult, Snapshot, Track, Transport } from "../types";

const transport: Transport = { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 };

const track = (id: string, over: Partial<Track> = {}): Track => ({
  id, index: 0, name: id, type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [{ id: `${id}-c` }], plugins: [], ...over,
} as unknown as Track);

const snapshot = (tracks: Track[]): Snapshot =>
  ({ schemaVersion: 1, session: { tempo: 120, length: 8 }, tracks, sections: [] }) as unknown as Snapshot;

describe("ExportControls — stems (G7)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const click = (id: string) => act(() => { q(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const select = (id: string, value: string) => {
    const el = q(id) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  // React routes a checkbox's onChange through the CLICK event, not "change" — so this has
  // to be the real gesture. Setting .checked and firing a synthetic change silently does
  // nothing, which would have made the include-empty assertion below quietly untestable.
  const check = (id: string, value: boolean) => {
    const el = q(id) as HTMLInputElement;
    if (el.checked !== value) act(() => { el.click(); });
  };
  const toStems = () => select("export-mode", "stems");

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true, command: "export_stems", data: { dir: "/mock/exports/stems-7", count: 2 } }) as CommandResult);
    useStore.setState({ exec, transport, snapshot: snapshot([track("Drums"), track("Bass")]) } as never);
    act(() => root.render(React.createElement(ExportControls, { audioEnabled: true })));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("defaults to a mixdown — the existing behaviour is untouched until you ask", () => {
    expect((q("export-mode") as HTMLSelectElement).value).toBe("mixdown");
    expect(q("export-range"), "range belongs to the mixdown").toBeTruthy();
    expect(q("export-include-empty")).toBeFalsy();
  });

  it("switching to stems drops the args export_stems does not have", () => {
    toStems();
    expect(q("export-range"), "Range is silently ignored by export_stems").toBeFalsy();
    expect(q("export-tail"), "Tail is silently ignored by export_stems").toBeFalsy();
    expect(q("export-include-empty")).toBeTruthy();
  });

  it("says how many files and where, before the click", () => {
    toStems();
    expect(q("export-stem-plan")!.textContent).toContain("2 file");
  });

  it("Export does not run — it asks first, and nothing is dispatched until you agree", () => {
    toStems();
    click("export-run");
    expect(exec, "started an uncancellable render on one click").not.toHaveBeenCalled();
    expect(q("export-stems-confirm")).toBeTruthy();
    // The producer is told the app will stop responding — this is the whole point of the gate.
    expect(q("export-stems-confirm")!.textContent).toContain("won't respond");
  });

  it("cancelling leaves the project alone", async () => {
    toStems();
    click("export-run");
    const cancel = [...host.querySelectorAll(".confirm-actions button")].find((b) => /cancel/i.test(b.textContent ?? ""))!;
    await act(async () => { cancel.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(exec).not.toHaveBeenCalled();
    expect(q("export-stems-confirm")).toBeFalsy();
  });

  it("confirming sends export_stems and NOTHING it would ignore", async () => {
    toStems();
    click("export-run");
    const go = [...host.querySelectorAll(".confirm-actions button")].find((b) => /Export 2 files/.test(b.textContent ?? ""))!;
    await act(async () => { go.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(exec).toHaveBeenCalledTimes(1);
    // No dir: there is no directory picker in this app, so the backend's default location
    // is the destination — the same choice the mixdown path already makes by omitting `file`.
    expect(exec).toHaveBeenCalledWith("export_stems", { format: "wav", bitDepth: 24 });
  });

  it("include-empty rides along only when asked", async () => {
    toStems();
    check("export-include-empty", true);
    click("export-run");
    const go = [...host.querySelectorAll(".confirm-actions button")].find((b) => /^Export /.test(b.textContent ?? ""))!;
    await act(async () => { go.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(exec).toHaveBeenCalledWith("export_stems", { format: "wav", bitDepth: 24, includeEmpty: true });
  });

  it("reports the engine's count and folder, not the pre-flight guess", async () => {
    exec.mockResolvedValue({ ok: true, command: "export_stems", data: { dir: "/mock/exports/stems-7", count: 5 } } as CommandResult);
    toStems();
    click("export-run");
    const go = [...host.querySelectorAll(".confirm-actions button")].find((b) => /^Export /.test(b.textContent ?? ""))!;
    await act(async () => { go.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const done = q("export-done")!;
    // 5, not the 2 the plan predicted — the done-block must report what HAPPENED.
    expect(done.textContent).toContain("5 stems");
    expect(done.textContent).toContain("/mock/exports/stems-7");
  });

  it("refuses up front when there is nothing to render", () => {
    useStore.setState({ snapshot: snapshot([track("Empty", { clips: [] })]) } as never);
    act(() => root.render(React.createElement(ExportControls, { audioEnabled: true })));
    toStems();
    // Native answers this with "no renderable tracks (all empty or hidden)". Preventing it
    // is kinder than surfacing it.
    expect((q("export-run") as HTMLButtonElement).disabled).toBe(true);
    expect(q("export-stem-plan")!.textContent).toContain("No tracks");
  });

  it("still exports a mixdown the old way", async () => {
    // The regression guard: adding a mode must not change the default call, which several
    // existing specs assert is byte-for-byte {format, bitDepth}.
    click("export-run");
    await act(async () => { await Promise.resolve(); });
    expect(exec).toHaveBeenCalledWith("export_audio", { format: "wav", bitDepth: 24 });
  });
});
