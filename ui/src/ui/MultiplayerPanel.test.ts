// Covers the join-with-code path (previously untested) and the new safety gate: a
// non-empty local project must be confirmed before mp_join_session dispatches, since
// the native mp_apply_bootstrap adopt step drops local tracks non-undoably
// (MoshOps.cpp cmdMpApplyBootstrap). Also covers identity persistence (name/color
// carried into create/join) and the room-code copy affordance.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultiplayerPanel } from "./MultiplayerPanel";
import { useStore } from "../store";
import type { Snapshot } from "../types";

// React installs a value tracker on every controlled <input> DOM node to decide
// whether a subsequent native "input" event represents a real change. A plain
// `input.value = x` assignment updates that tracker too (since it's the very setter
// React wraps), so a same-tick dispatched "input" event reads as a no-op change and
// onChange never fires. Route through the ORIGINAL (unwrapped) native setter so React
// sees the DOM value diverge from what it last tracked, exactly like a real keystroke.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function setInputValue(input: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function snapshotWithTracks(count: number): Snapshot {
  return {
    schemaVersion: 1,
    session: { editFile: "/mock/song.mosh" },
    tracks: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, index: i, name: `Track ${i}`, type: "audio", clips: [] })),
  } as unknown as Snapshot;
}

describe("MultiplayerPanel — create/join UX + the join-replaces-project safety gate", () => {
  let host: HTMLDivElement;
  let root: Root;
  let mpCreateSession: ReturnType<typeof vi.fn>;
  let mpJoinSession: ReturnType<typeof vi.fn>;
  let mpLeaveSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mpCreateSession = vi.fn(async () => {});
    mpJoinSession = vi.fn(async () => ({ ok: true, command: "mp_join_session" }));
    mpLeaveSession = vi.fn(async () => {});
    useStore.setState({
      mp: { active: false, roomCode: null, selfPeer: null, connected: false },
      peers: {},
      mpCreateSession,
      mpJoinSession,
      mpLeaveSession,
      snapshot: snapshotWithTracks(0),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render() {
    act(() => { root.render(React.createElement(MultiplayerPanel)); });
  }

  it("pre-fills a first-run identity (non-blank name) rather than a blank field", () => {
    render();
    const nameInput = host.querySelector<HTMLInputElement>('label.mp-field input:not([type="color"])');
    expect(nameInput).not.toBeNull();
    expect(nameInput!.value.trim().length).toBeGreaterThan(0);
  });

  it("Create session calls mpCreateSession with the typed name/color and persists it", () => {
    render();
    const nameInput = host.querySelector<HTMLInputElement>('label.mp-field input:not([type="color"])')!;
    act(() => { setInputValue(nameInput, "Ada"); });
    const createBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Create session")!;
    act(() => { createBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(mpCreateSession).toHaveBeenCalledWith("Ada", expect.stringMatching(/^#[0-9a-fA-F]{6}$/));
    expect(JSON.parse(localStorage.getItem("mosh.mp.identity")!).name).toBe("Ada");
  });

  it("Create session never sends a blank name, even if the field is cleared", () => {
    render();
    const nameInput = host.querySelector<HTMLInputElement>('label.mp-field input:not([type="color"])')!;
    act(() => { setInputValue(nameInput, "   "); });
    const createBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Create session")!;
    act(() => { createBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(mpCreateSession).toHaveBeenCalledWith("Producer", expect.any(String));
  });

  it("joins immediately (no confirm) when the local project is empty", () => {
    render();
    const codeInput = host.querySelector<HTMLInputElement>('input[aria-label="Room code to join"]')!;
    act(() => { setInputValue(codeInput, "ROOM-123"); });
    const joinBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Join")!;
    act(() => { joinBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(mpJoinSession).toHaveBeenCalledWith("ROOM-123", expect.any(String), expect.any(String));
    expect(host.querySelector('[data-testid="mp-join-confirm"]')).toBeNull();
  });

  it("gates Join behind a confirm dialog when the local project has tracks — Cancel does NOT join", () => {
    useStore.setState({ snapshot: snapshotWithTracks(3) });
    render();
    const codeInput = host.querySelector<HTMLInputElement>('input[aria-label="Room code to join"]')!;
    act(() => { setInputValue(codeInput, "ROOM-456"); });
    const joinBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Join")!;
    act(() => { joinBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(mpJoinSession).not.toHaveBeenCalled();
    const dialog = host.querySelector('[data-testid="mp-join-confirm"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toMatch(/3 track/);

    const cancelBtn = Array.from(dialog!.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!;
    act(() => { cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(mpJoinSession).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="mp-join-confirm"]')).toBeNull();
  });

  it("confirming the join-replaces-project dialog dispatches mp_join_session", () => {
    useStore.setState({ snapshot: snapshotWithTracks(2) });
    render();
    const codeInput = host.querySelector<HTMLInputElement>('input[aria-label="Room code to join"]')!;
    act(() => { setInputValue(codeInput, "ROOM-789"); });
    const joinBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Join")!;
    act(() => { joinBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const confirmBtn = host.querySelector<HTMLButtonElement>('[data-testid="mp-join-confirm-confirm"]')!;
    expect(confirmBtn).not.toBeNull();
    act(() => { confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(mpJoinSession).toHaveBeenCalledWith("ROOM-789", expect.any(String), expect.any(String));
    expect(host.querySelector('[data-testid="mp-join-confirm"]')).toBeNull();
  });

  it("an active session shows a re-copyable room code + roster + a Leave control", () => {
    useStore.setState({
      mp: { active: true, roomCode: "ROOM-ABC", selfPeer: "me", connected: true },
      peers: { me: { name: "Ada", color: "#3aa0ff", online: true }, bo: { name: "Bo", color: "#e0457b", online: true } },
    });
    render();
    const codeField = host.querySelector<HTMLInputElement>('input[aria-label="Room code (share to invite)"]');
    expect(codeField?.value).toBe("ROOM-ABC");
    const copyBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Copy");
    expect(copyBtn).toBeTruthy();
    expect(host.textContent).toContain("Bo");
    const leaveBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Leave session")!;
    act(() => { leaveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(mpLeaveSession).toHaveBeenCalled();
  });

  // #42 (EDGECASE_SWEEP_V2_2026-07-18) — join failures used to surface only in the
  // global error bar; the panel the user is LOOKING AT stayed silent. These pin the
  // inline pending + failure feedback.
  const joinWith = (code: string) => {
    const codeInput = host.querySelector<HTMLInputElement>('input[aria-label="Room code to join"]')!;
    act(() => { setInputValue(codeInput, code); });
    const joinBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Join"))!;
    act(() => { joinBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  };

  it("a failed join shows an inline error in the panel (#42)", async () => {
    mpJoinSession.mockResolvedValue({ ok: false, command: "mp_join_session", error: "no such room: JUNK-1" });
    render();
    joinWith("JUNK-1");
    await act(async () => {});
    const errEl = host.querySelector('[data-testid="mp-join-error"]');
    expect(errEl).not.toBeNull();
    expect(errEl!.textContent).toContain("no such room");
    expect(errEl!.getAttribute("role")).toBe("alert");
  });

  it("the Join control shows a pending state while the join is in flight", async () => {
    let resolveJoin!: (r: unknown) => void;
    mpJoinSession.mockReturnValue(new Promise((r) => { resolveJoin = r; }));
    render();
    joinWith("SLOW-ROOM");
    const joinBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Join"))!;
    expect(joinBtn.textContent).toMatch(/joining/i);
    expect(joinBtn.hasAttribute("disabled")).toBe(true);
    await act(async () => { resolveJoin({ ok: true, command: "mp_join_session" }); });
  });

  it("editing the code clears a stale join error", async () => {
    mpJoinSession.mockResolvedValue({ ok: false, command: "mp_join_session", error: "no such room: JUNK-2" });
    render();
    joinWith("JUNK-2");
    await act(async () => {});
    expect(host.querySelector('[data-testid="mp-join-error"]')).not.toBeNull();
    const codeInput = host.querySelector<HTMLInputElement>('input[aria-label="Room code to join"]')!;
    act(() => { setInputValue(codeInput, "JUNK-3"); });
    expect(host.querySelector('[data-testid="mp-join-error"]')).toBeNull();
  });

  it("a successful join shows no inline error", async () => {
    mpJoinSession.mockResolvedValue({ ok: true, command: "mp_join_session" });
    render();
    joinWith("MOCK-ROOM-x");
    await act(async () => {});
    expect(host.querySelector('[data-testid="mp-join-error"]')).toBeNull();
  });
});
