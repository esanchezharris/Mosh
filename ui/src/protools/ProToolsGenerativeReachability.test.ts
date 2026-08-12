import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { AppProTools } from "./AppProTools";

vi.mock("../bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge")>();
  return { ...actual, isNative: () => true };
});
vi.mock("../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock("../hooks/useQwertyMidi", () => ({ useQwertyMidi: vi.fn() }));
vi.mock("../hooks/useFileDrop", () => ({ useFileDrop: () => false }));
vi.mock("./ProToolsArrangement", () => ({
  ProToolsArrangement: () => React.createElement("div", { "data-testid": "pt-arrangement-stub" }),
}));
vi.mock("./ProToolsDetailDock", () => ({ ProToolsDetailDock: () => null }));
vi.mock("./ProToolsStatusBar", () => ({ ProToolsStatusBar: () => null }));

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-generative.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    {
      id: "track-a",
      index: 0,
      name: "Selected Track",
      type: "audio",
      clips: [{
        id: "clip-a",
        name: "Selected Track Clip",
        type: "wave",
        start: 0,
        length: 4,
        offset: 0,
        hasRenderLayer: false,
      }],
    },
    {
      id: "track-b",
      index: 1,
      name: "Clip Selection Track",
      type: "audio",
      clips: [{
        id: "clip-b",
        name: "Direct Target",
        type: "wave",
        start: 4,
        length: 4,
        offset: 0,
        hasRenderLayer: false,
      }],
    },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Pro Tools generative reachability", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();
  const originalSelectedClipId = useShell.getState().selectedClipId;

  const trigger = () => host.querySelector<HTMLButtonElement>("[data-testid=pt-open-generative]");
  const open = async () => {
    const button = trigger();
    if (!button) throw new Error("Pro Tools Re-imagine trigger is missing");
    await act(async () => button.click());
    return button;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      projectEpoch: 41,
      transport: SNAPSHOT.transport,
      selectedTrackId: "track-a",
      selection: new Set(["clip-b"]),
      editingClipId: null,
      lastError: null,
      peers: {},
      availableColors: [],
      availableLoras: [],
      availableTransformTargets: [],
      sa3Available: true,
      qaByClip: {},
      loadColors: vi.fn(async () => {}),
      loadTransformTargets: vi.fn(async () => {}),
      loadLoras: vi.fn(async () => {}),
      exec,
    });
    useShell.setState({ selectedClipId: null });
    act(() => root.render(React.createElement(AppProTools)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating, .mosh-tip").forEach((node) => node.remove());
    useStore.setState({
      snapshot: originalState.snapshot,
      projectEpoch: originalState.projectEpoch,
      transport: originalState.transport,
      selectedTrackId: originalState.selectedTrackId,
      selection: originalState.selection,
      editingClipId: originalState.editingClipId,
      lastError: originalState.lastError,
      peers: originalState.peers,
      availableColors: originalState.availableColors,
      availableLoras: originalState.availableLoras,
      availableTransformTargets: originalState.availableTransformTargets,
      sa3Available: originalState.sa3Available,
      qaByClip: originalState.qaByClip,
      loadColors: originalState.loadColors,
      loadTransformTargets: originalState.loadTransformTargets,
      loadLoras: originalState.loadLoras,
      exec: originalState.exec,
    });
    useShell.setState({ selectedClipId: originalSelectedClipId });
  });

  it("opens nonmodally on the selected clip, focuses the shared rack, and restores focus", async () => {
    expect(host.querySelector("[data-testid=pt-generative-drawer]")).toBeNull();
    const button = await open();
    const drawer = host.querySelector<HTMLElement>("[data-testid=pt-generative-drawer]");
    expect(drawer?.getAttribute("role")).toBe("complementary");
    expect(drawer?.hasAttribute("aria-modal")).toBe(false);
    expect(drawer?.textContent).toContain("Direct Target");
    expect(document.activeElement).toBe(drawer?.querySelector("[data-testid=gen-compile-input]"));

    const close = drawer?.querySelector<HTMLButtonElement>("[data-testid=pt-generative-close]");
    if (!close) throw new Error("Pro Tools Re-imagine close button is missing");
    await act(async () => close.click());
    expect(host.querySelector("[data-testid=pt-generative-drawer]")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("routes the truthful SA3 create contract to the current selected clip", async () => {
    await open();
    const create = host.querySelector<HTMLButtonElement>("[data-testid=gen-create]");
    if (!create) throw new Error("shared Re-imagine create control is missing");
    await act(async () => create.click());

    expect(host.querySelector("[data-testid=engine-badge]")?.textContent).toBe("SA3");
    expect(exec).toHaveBeenCalledWith("create_render_layer", {
      clipId: "clip-b",
      adapter: "stable_audio3",
      mode: "reimagine",
      modelVariant: "sa3-medium",
    });
  });

  it("targets the focused member when clip-group selection contains multiple clips", async () => {
    act(() => {
      useStore.setState({
        snapshot: {
          ...SNAPSHOT,
          clipGroups: [{
            id: "group-a",
            name: "Grouped Clips",
            clipIds: ["clip-a", "clip-b"],
            active: true,
          }],
        },
        selection: new Set(["clip-a", "clip-b"]),
      });
      useShell.setState({ selectedClipId: "clip-b" });
    });

    await open();
    expect(host.querySelector("[data-testid=pt-generative-drawer]")?.textContent)
      .toContain("Direct Target");
    const create = host.querySelector<HTMLButtonElement>("[data-testid=gen-create]");
    if (!create) throw new Error("shared Re-imagine create control is missing");
    await act(async () => create.click());

    expect(exec).toHaveBeenCalledWith("create_render_layer", {
      clipId: "clip-b",
      adapter: "stable_audio3",
      mode: "reimagine",
      modelVariant: "sa3-medium",
    });
  });

  it("labels and routes the preview fallback honestly when SA3 is unavailable", async () => {
    act(() => useStore.setState({ sa3Available: false }));
    await open();
    const create = host.querySelector<HTMLButtonElement>("[data-testid=gen-create]");
    if (!create) throw new Error("shared Re-imagine create control is missing");
    await act(async () => create.click());

    expect(host.querySelector("[data-testid=engine-badge]")?.textContent).toBe("preview");
    expect(exec).toHaveBeenCalledWith("create_render_layer", {
      clipId: "clip-b",
      adapter: "fake",
      mode: "reimagine",
      modelVariant: "",
    });
  });

  it("closes stale controls on project replacement and never overlaps Ask Moshi", async () => {
    await open();
    expect(host.querySelector("[data-testid=pt-generative-drawer]")).not.toBeNull();
    const moshi = host.querySelector<HTMLButtonElement>("[data-testid=pt-ask-moshi]");
    if (!moshi) throw new Error("Ask Moshi trigger is missing");
    await act(async () => moshi.click());
    expect(host.querySelector("[data-testid=pt-generative-drawer]")).toBeNull();
    expect(host.querySelector("[data-testid=pt-moshi-drawer]")).not.toBeNull();

    await act(async () => moshi.click());
    await open();
    act(() => useStore.setState({ projectEpoch: 42 }));
    expect(host.querySelector("[data-testid=pt-generative-drawer]")).toBeNull();
  });

  it("retargets current selection and discards a draft addressed to the prior clip", async () => {
    await open();
    const input = host.querySelector<HTMLInputElement>("[data-testid=gen-compile-input]");
    if (!input) throw new Error("shared Compile field is missing");
    act(() => setInputValue(input, "make the old target darker"));
    expect(input.value).toBe("make the old target darker");

    act(() => useStore.setState({ selection: new Set(["clip-a"]) }));

    const retargeted = host.querySelector<HTMLInputElement>("[data-testid=gen-compile-input]");
    expect(host.querySelector("[data-testid=pt-generative-drawer]")?.textContent)
      .toContain("Selected Track Clip");
    expect(retargeted?.value).toBe("");
  });

  it("keeps an empty project honest and focuses its only available drawer action", async () => {
    act(() => useStore.setState({
      snapshot: { ...SNAPSHOT, tracks: [] },
      selection: new Set(),
      selectedTrackId: null,
    }));
    await open();

    const drawer = host.querySelector<HTMLElement>("[data-testid=pt-generative-drawer]");
    expect(drawer?.textContent).toContain("Add and select a clip");
    expect(document.activeElement).toBe(drawer?.querySelector("[data-testid=pt-generative-close]"));
  });
});
