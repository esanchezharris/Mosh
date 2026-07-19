// The v2 shell's prominent multiplayer entry point (TopBar "Invite" pill + the
// RightRail "Invite collaborator" button both render this). Regression coverage for
// the playtest blocker: previously these buttons called mpCreateSession() directly
// with no Join-with-code path anywhere in the default shell. Now they open a modal
// carrying the full create/join panel.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultiplayerLauncher } from "./MultiplayerLauncher";
import { useStore } from "../store";
import type { Snapshot } from "../types";

describe("v2 MultiplayerLauncher", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      mp: { active: false, roomCode: null, selfPeer: null, connected: false },
      peers: {},
      mpCreateSession: vi.fn(async () => {}),
      mpJoinSession: vi.fn(async () => ({ ok: true, command: "mp_join_session" })),
      mpLeaveSession: vi.fn(async () => {}),
      snapshot: { schemaVersion: 1, session: { editFile: "/mock/song.mosh" }, tracks: [] } as unknown as Snapshot,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(props: { className?: string; label: React.ReactNode; ariaLabel?: string; testId?: string }) {
    act(() => { root.render(React.createElement(MultiplayerLauncher, props)); });
  }

  it("renders only the trigger button — no modal — until clicked", () => {
    render({ label: "Invite", testId: "the-trigger" });
    expect(host.querySelector('[data-testid="mp-launcher-modal"]')).toBeNull();
    const trigger = host.querySelector('[data-testid="the-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking the trigger opens a modal with BOTH create and join affordances", () => {
    render({ label: "Invite", testId: "the-trigger" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="the-trigger"]')!;
    act(() => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const modal = host.querySelector('[data-testid="mp-launcher-modal"]');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain("Create session");
    expect(modal!.textContent).toMatch(/join with a code/i);
    expect(modal!.querySelector('input[aria-label="Room code to join"]')).not.toBeNull();
  });

  it("the close (✕) button dismisses the modal", () => {
    render({ label: "Invite", testId: "the-trigger" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="the-trigger"]')!;
    act(() => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(host.querySelector('[data-testid="mp-launcher-modal"]')).not.toBeNull();

    const closeBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "✕")!;
    act(() => { closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(host.querySelector('[data-testid="mp-launcher-modal"]')).toBeNull();
  });

  it("Escape dismisses the modal", () => {
    render({ label: "Invite", testId: "the-trigger" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="the-trigger"]')!;
    act(() => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(host.querySelector('[data-testid="mp-launcher-modal"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-testid="mp-launcher-modal"]')).toBeNull();
  });

  it("once a session is active, re-opening surfaces the room code (re-share path)", () => {
    useStore.setState({ mp: { active: true, roomCode: "ROOM-XYZ", selfPeer: "me", connected: true }, peers: {} });
    render({ label: "Shared", testId: "the-trigger" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="the-trigger"]')!;
    act(() => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const codeField = host.querySelector<HTMLInputElement>('input[aria-label="Room code (share to invite)"]');
    expect(codeField?.value).toBe("ROOM-XYZ");
  });
});
