import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReImagineSection } from "./ReImagineSection";
import { useStore } from "../store";
import type { Clip, CommandResult, Snapshot, Track } from "../types";

vi.mock("../bridge", async (original) => ({ ...await original<typeof import("../bridge")>(), onEvent: vi.fn(() => () => {}) }));
const source: Clip = { id: "source", name: "Synthetic source", type: "wave", start: 0, offset: 1, length: 4, hasRenderLayer: false };
const context: Clip = { ...source, id: "context", name: "Context audio" };
const tracks: Track[] = [source, context].map((clip, index) => ({ id: `track-${index}`, index, name: `Track ${index}`, type: "audio", clips: [clip] }));
const snapshot: Snapshot = { schemaVersion: 1, session: { key: { tonic: "A", mode: "minor" }, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, sampleRate: 48000, length: 4, editFile: "fixture.mosh" }, tracks, transport: { playing: false, recording: false, looping: false, position: 0, loopStart: 0, loopEnd: 4 } };

describe("V3 direct Re-Imagine targeting", () => {
  let host: HTMLDivElement;
  let root: Root;
  const original = useStore.getState();
  const exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
  const render = (value = snapshot) => act(() => root.render(React.createElement(ReImagineSection, { snapshot: value })));
  const click = async (id: string) => {
    const button = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!button) throw new Error(`Missing ${id}`);
    await act(async () => button.click());
  };
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    exec.mockClear();
    useStore.setState({ selection: new Set(), projectEpoch: 7, exec, sa3Available: true, explicitRenderDecision: true,
      directRenderTestFixture: false, genServiceState: "ready", loadColors: vi.fn(async () => {}) });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); useStore.setState(original); });

  it("requires one explicitly selected audio clip and sends direct commands", async () => {
    render();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-reimagine-open"]')?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="gen-prompt"]')).toBeNull();
    act(() => useStore.setState({ selection: new Set(["source", "context"]) }));
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-reimagine-open"]')?.disabled).toBe(true);
    act(() => useStore.setState({ selection: new Set(["source"]) }));
    await click("v3-reimagine-open"); await click("gen-render");
    expect(exec.mock.calls).toEqual([
      ["create_render_layer", { clipId: "source", decisionPolicy: "explicit", adapter: "stable_audio3", mode: "reimagine", modelVariant: "sa3-medium" }],
      ["set_render_param", { clipId: "source", prompt: "", nl: 0.4, seed: 0 }], ["render_layer", { clipId: "source" }],
    ]);
  });

  it("pins across selection changes and explicitly reopens on the new selection", async () => {
    useStore.setState({ selection: new Set(["source"]) }); render(); await click("v3-reimagine-open");
    act(() => useStore.setState({ selection: new Set(["context"]) }));
    expect(host.querySelector('[data-testid="gen-target"]')?.textContent).toContain("Synthetic source");
    await click("v3-reimagine-close"); await click("v3-reimagine-open");
    expect(host.querySelector('[data-testid="gen-target"]')?.textContent).toContain("Context audio");
  });

  it("invalidates deleted targets and replaced projects with reused IDs", async () => {
    useStore.setState({ selection: new Set(["source"]) }); render(); await click("v3-reimagine-open");
    render({ ...snapshot, tracks: [] });
    expect(host.querySelector('[data-testid="gen-render"]')).toBeNull();
    expect(host.textContent).toContain("no longer available");
    act(() => useStore.setState({ projectEpoch: 8 })); render();
    expect(host.querySelector('[data-testid="gen-render"]')).toBeNull();
  });

  it("restores committed audio when closing an audition", async () => {
    const clip: Clip = { ...source, renderLayer: { id: "layer", status: "ready", adapter: "stable_audio3", mode: "reimagine", seed: 0, userKept: false, hasArtifact: true, decisionPolicy: "explicit", hasPending: true, audition: "result" } };
    useStore.setState({ selection: new Set(["source"]) });
    render({ ...snapshot, tracks: [{ ...tracks[0], clips: [clip] }] });
    await click("v3-reimagine-open"); await click("v3-reimagine-close");
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "source", audition: "committed" });
  });
});
