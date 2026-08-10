import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsTrackGroupsPanel } from "./ProToolsTrackGroupsPanel";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48_000, tempo: 120, editFile: "/tmp/track-groups.mosh", key: { tonic: "C", mode: "major" } },
  tracks: [
    { id: "drums", index: 0, name: "Drums", type: "audio", clips: [], volumeDb: 0, pan: 0 },
    { id: "bass", index: 1, name: "Bass", type: "audio", clips: [], volumeDb: -3, pan: 0 },
  ],
  trackGroups: [{
    id: "rhythm",
    name: "Rhythm",
    trackIds: ["drums", "bass"],
    kind: "edit_mix",
    enabled: true,
  }],
  trackGroupsSuspended: false,
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Pro Tools Track Group configuration", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalStore = useStore.getState();
  const originalProTools = useProTools.getState();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: SNAPSHOT, selectedTrackId: "drums", projectEpoch: 12, exec });
    useProTools.setState({ trackSelectionIds: ["drums", "bass"], trackGroupDialogOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalStore.snapshot,
      selectedTrackId: originalStore.selectedTrackId,
      projectEpoch: originalStore.projectEpoch,
      exec: originalStore.exec,
    });
    useProTools.setState({
      trackSelectionIds: originalProTools.trackSelectionIds,
      trackGroupDialogOpen: originalProTools.trackGroupDialogOpen,
    });
  });

  async function openGroupAction(testId: "pt-track-group-modify" | "pt-track-group-duplicate"): Promise<void> {
    act(() => root.render(React.createElement(ProToolsTrackGroupsPanel, { snapshot: SNAPSHOT })));
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-menu]");
    if (!trigger) throw new Error("Track Group action menu is missing");
    trigger.focus();
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  it("configures name, type, membership, and supported attributes in one command", async () => {
    await openGroupAction("pt-track-group-modify");
    const name = document.querySelector<HTMLInputElement>("[data-testid=pt-track-group-modify-name]");
    const kind = document.querySelector<HTMLSelectElement>("[data-testid=pt-track-group-modify-kind]");
    if (!name || !kind) throw new Error("Modify Group configuration fields are missing");
    await act(async () => {
      setInputValue(name, "Band");
      kind.value = "mix";
      kind.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>(
      "[data-testid=pt-track-group-tab-attributes]",
    )?.click());
    const recordEnable = document.querySelector<HTMLInputElement>(
      "[data-testid=pt-track-group-attribute-record_enable]",
    );
    if (!recordEnable) throw new Error("Record Enable attribute is missing");
    await act(async () => recordEnable.click());
    await act(async () => document.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-apply]")?.click());

    expect(exec).toHaveBeenCalledWith("configure_track_group", {
      groupId: "rhythm",
      name: "Band",
      kind: "mix",
      trackIds: ["drums", "bass"],
      mixAttributes: ["main_volume", "main_mute", "main_pan", "solo", "record_enable"],
    });
    expect(document.querySelector("[data-testid=pt-track-group-modify-dialog]")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-testid=pt-track-group-menu]"));
  });

  it("opens Duplicate Group as a separate prefilled definition", async () => {
    await openGroupAction("pt-track-group-duplicate");
    const dialog = document.querySelector<HTMLElement>("[data-testid=pt-track-group-modify-dialog]");
    const name = document.querySelector<HTMLInputElement>("[data-testid=pt-track-group-modify-name]");
    expect(dialog?.textContent).toContain("Duplicate Rhythm");
    expect(name?.value).toBe("Rhythm Copy");
    await act(async () => document.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-apply]")?.click());

    expect(exec).toHaveBeenCalledWith("duplicate_track_group", {
      groupId: "rhythm",
      name: "Rhythm Copy",
      kind: "edit_mix",
      trackIds: ["drums", "bass"],
      mixAttributes: ["main_volume", "main_mute", "main_pan", "solo"],
    });
    expect(document.querySelector("[data-testid=pt-track-group-modify-dialog]")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-testid=pt-track-group-menu]"));
  });

  it("moves between configuration tabs with arrow keys", async () => {
    await openGroupAction("pt-track-group-modify");
    const tracksTab = document.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-tab-tracks]");
    const attributesTab = document.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-tab-attributes]");
    if (!tracksTab || !attributesTab) throw new Error("Track Group tabs are missing");
    tracksTab.focus();
    expect(tracksTab.tabIndex).toBe(0);
    expect(attributesTab.tabIndex).toBe(-1);

    await act(async () => tracksTab.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    })));

    expect(attributesTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(attributesTab);
    expect(tracksTab.tabIndex).toBe(-1);
    expect(attributesTab.tabIndex).toBe(0);
    expect(document.querySelector<HTMLElement>("#pt-track-group-panel-tracks")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#pt-track-group-panel-attributes")?.hidden).toBe(false);
  });

  it("contains forward and reverse Tab focus inside Modify Group", async () => {
    await openGroupAction("pt-track-group-modify");
    const name = document.querySelector<HTMLInputElement>("[data-testid=pt-track-group-modify-name]");
    const apply = document.querySelector<HTMLButtonElement>("[data-testid=pt-track-group-apply]");
    if (!name || !apply) throw new Error("Modify Group focus targets are missing");
    expect(document.activeElement).toBe(name);

    await act(async () => name.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));
    expect(document.activeElement).toBe(apply);

    await act(async () => apply.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    })));
    expect(document.activeElement).toBe(name);
  });
});
