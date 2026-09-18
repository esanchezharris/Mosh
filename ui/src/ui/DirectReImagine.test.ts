import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Clip, CommandResult, RenderLayer, Track } from "../types";
import { GenDrawer } from "./GenDrawer";

vi.mock("../bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../bridge")>(),
  onEvent: vi.fn(() => () => {}),
}));

const layer = (overrides: Partial<RenderLayer> = {}): RenderLayer => ({
  id: "layer-one", status: "ready", adapter: "stable_audio3", mode: "reimagine",
  decisionPolicy: "explicit", seed: 0, userKept: false, hasArtifact: true,
  hasPending: true, audition: "committed", jobId: "job-one", requestId: "request-one",
  prompt: "A sustained synthesizer tone.", nl: 0.4, ...overrides,
});
const clip = (renderLayer?: RenderLayer): Clip => ({
  id: "clip-one", name: "Synthetic tone", type: "wave", start: 8, length: 4, offset: 2,
  hasRenderLayer: !!renderLayer, renderLayer,
});
const track = (value: Clip): Track => ({ id: "track-one", index: 0, name: "Fixture track", type: "audio", clips: [value] });

describe("direct Re-Imagine", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalState = useStore.getState();
  let exec: ReturnType<typeof vi.fn>;
  const render = (value = clip()) => act(() => root.render(React.createElement(GenDrawer, {
    track: track(value), selectedClipId: value.id, direct: true,
  })));
  const button = (testId: string): HTMLButtonElement => {
    const found = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!found) throw new Error(`Missing control: ${testId}`);
    return found;
  };
  const input = (testId: string): HTMLInputElement => {
    const found = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    if (!found) throw new Error(`Missing field: ${testId}`);
    return found;
  };
  const edit = (testId: string, value: string) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Input setter unavailable");
    setter.call(input(testId), value);
    input(testId).dispatchEvent(new Event("input", { bubbles: true }));
  });

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ exec, projectEpoch: 9, sa3Available: true, genServiceState: "ready",
      explicitRenderDecision: true, directRenderTestFixture: false,
      genServiceError: null, availableColors: [], availableLoras: [],
      loadColors: vi.fn(async () => {}), loadLoras: vi.fn(async () => {}),
      loadTransformTargets: vi.fn(async () => {}),
    });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); useStore.setState(originalState); });

  it.each([false, undefined])("blocks generation without affirmative SA3 capability (%s)", async (available) => {
    // Given a service which does not affirm SA3 availability.
    useStore.setState({ sa3Available: available }); render();
    // When generation is requested.
    await act(async () => button("gen-render").click());
    // Then no adapter, including fake, receives a command.
    expect(button("gen-render").disabled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("sends explicit prompt, strength and seed directly to SA3 when generating", async () => {
    // Given one selected source and user-edited controls.
    render(); edit("gen-prompt", "A soft flute."); edit("gen-nl", "25"); edit("gen-seed-input", "17");
    // When the user generates.
    await act(async () => button("gen-render").click());
    // Then commands address the fixed source without a compiler or agent.
    expect(exec.mock.calls).toEqual([
      ["create_render_layer", { clipId: "clip-one", decisionPolicy: "explicit", adapter: "stable_audio3", mode: "reimagine", modelVariant: "sa3-medium" }],
      ["set_render_param", { clipId: "clip-one", prompt: "A soft flute.", nl: 0.1325, seed: 17 }],
      ["render_layer", { clipId: "clip-one" }],
    ]);
  });

  it("keeps pending result decisions available when the service becomes unavailable", async () => {
    // Given stored audio and a service outage.
    useStore.setState({ sa3Available: false }); render(clip(layer()));
    // When the user keeps that result.
    await act(async () => button("gen-accept").click());
    // Then accepting stored audio does not depend on inference availability.
    expect(exec).toHaveBeenCalledWith("accept_render", { clipId: "clip-one" });
    expect(button("gen-reject").disabled).toBe(false);
    expect(button("gen-result").disabled).toBe(false);
  });

  it("auditions through the clip command without locally changing its pressed state", async () => {
    // Given a pending result with committed playback.
    render(clip(layer()));
    // When Result is selected.
    await act(async () => button("gen-result").click());
    // Then only native truth can confirm the listening state.
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "clip-one", audition: "result" });
    expect(button("gen-result").getAttribute("aria-pressed")).toBe("false");
  });

  it("restores committed playback when the drawer closes during result audition", () => {
    // Given a result currently auditioning.
    render(clip(layer({ audition: "result" })));
    // When the drawer unmounts.
    act(() => root.render(null));
    // Then it restores the committed source through MoshOps.
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "clip-one", audition: "committed" });
  });

  it("addresses cancellation to the actual job and request", async () => {
    // Given a running job.
    render(clip(layer({ status: "rendering", hasPending: false })));
    // When the user cancels.
    await act(async () => button("gen-cancel").click());
    // Then no selection-derived or unbound cancellation is sent.
    expect(exec).toHaveBeenCalledWith("cancel_render", { clipId: "clip-one", jobId: "job-one", requestId: "request-one" });
    expect(input("gen-prompt").disabled).toBe(true);
    expect(button("gen-render").disabled).toBe(true);
  });

  it("does not submit after a failed parameter command", async () => {
    // Given a command boundary rejecting the parameters.
    exec.mockImplementation(async (command: string): Promise<CommandResult> => ({ ok: command !== "set_render_param", command }));
    render(clip(layer({ hasPending: false }))); edit("gen-seed-input", "3");
    // When generation is requested.
    await act(async () => button("gen-render").click());
    // Then model execution never starts.
    expect(exec).not.toHaveBeenCalledWith("render_layer", expect.anything());
  });
  it("restores playback on close before an audition snapshot arrives", async () => {
    // Given a pending result whose snapshot still reports committed playback.
    render(clip(layer()));
    await act(async () => button("gen-result").click());
    exec.mockClear();
    // When the drawer closes before the native snapshot refresh.
    act(() => root.render(null));
    // Then the restore is still sent after the audition command.
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "clip-one", audition: "committed" });
  });

  it("stops the command chain when the session changes during creation", async () => {
    // Given creation completes after the project has changed.
    exec.mockImplementation(async (command: string): Promise<CommandResult> => {
      if (command === "create_render_layer") useStore.setState({ projectEpoch: 10 });
      return { ok: true, command };
    });
    render();
    // When generation is requested.
    await act(async () => button("gen-render").click());
    // Then no later command can address a clip in the replacement session.
    expect(exec.mock.calls.map(([name]) => name)).toEqual(["create_render_layer"]);
  });

  it("rejects a pending result through its pinned clip command", async () => {
    // Given a pending result.
    render(clip(layer()));
    // When the result is rejected.
    await act(async () => button("gen-reject").click());
    // Then rejection addresses that result's clip.
    expect(exec).toHaveBeenCalledWith("reject_render", { clipId: "clip-one" });
  });

  it.each([false, undefined])("requires explicit-decision support even with real SA3 (%s)", async (supported) => {
    useStore.setState({ explicitRenderDecision: supported }); render();
    await act(async () => button("gen-render").click());
    expect(button("gen-render").disabled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("labels an authorized test fixture before a layer exists without claiming SA3", async () => {
    useStore.setState({ sa3Available: false, explicitRenderDecision: true, directRenderTestFixture: true }); render();
    expect(host.querySelector('[data-testid="engine-badge"]')?.textContent).toBe("Test fixture");
    await act(async () => button("gen-render").click());
    expect(exec).toHaveBeenCalledWith("render_layer", { clipId: "clip-one" });
  });

  it("keeps Result audition available after keeping audio", async () => {
    render(clip(layer({ hasPending: false, userKept: true })));
    await act(async () => button("gen-result").click());
    expect(button("gen-result").disabled).toBe(false);
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "clip-one", audition: "result" });
    expect(button("gen-accept").disabled).toBe(true);
  });

});
