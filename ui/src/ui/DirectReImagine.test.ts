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

  // ── A11: "Generate again" must not silently re-run the same seed ─────────────────────
  const sentSeed = () => {
    const call = exec.mock.calls.find(([name]) => name === "set_render_param");
    if (!call) throw new Error("set_render_param was not sent");
    return (call[1] as { seed: number }).seed;
  };

  it("Generate again with an untouched seed sends seed+1 and shows it in the field", async () => {
    render(clip(layer({ hasPending: false, userKept: true, seed: 0 })));
    expect(button("gen-render").textContent).toBe("Generate again");
    expect(input("gen-seed-input").value).toBe("0");                      // baseline
    await act(async () => button("gen-render").click());
    expect(sentSeed()).toBe(1);
    expect(input("gen-seed-input").value, "the advanced seed is visible, not hidden").toBe("1");
  });

  it("Discard pending and generate also advances an untouched seed", async () => {
    render(clip(layer({ hasPending: true, seed: 41 })));
    expect(button("gen-render").textContent).toBe("Discard pending and generate");
    await act(async () => button("gen-render").click());
    expect(sentSeed()).toBe(42);
  });

  it("a typed seed is sent exactly as typed — even when it equals the layer's seed", async () => {
    render(clip(layer({ hasPending: false, userKept: true, seed: 5 })));
    edit("gen-seed-input", ""); edit("gen-seed-input", "5");             // select-all, retype the same number
    await act(async () => button("gen-render").click());
    expect(sentSeed(), "retyping the same seed is a deliberate reproduce").toBe(5);

    exec.mockClear();
    act(() => root.render(null));
    render(clip(layer({ hasPending: false, userKept: true, seed: 5 })));
    edit("gen-seed-input", "1234");
    await act(async () => button("gen-render").click());
    expect(sentSeed()).toBe(1234);
  });

  it("wraps the advanced seed at the top of the valid range", async () => {
    render(clip(layer({ hasPending: false, userKept: true, seed: 2147483647 })));
    await act(async () => button("gen-render").click());
    expect(sentSeed()).toBe(0);
  });

  it("the first Generate on a layer with no result sends the layer's seed unchanged", async () => {
    render(clip(layer({ status: "empty", hasArtifact: false, hasPending: false, userKept: false, seed: 7 })));
    expect(button("gen-render").textContent).toBe("Generate");
    await act(async () => button("gen-render").click());
    expect(sentSeed()).toBe(7);
  });

  // ── A12: elapsed time on the status, clock from the Generate CLICK ────────────────────
  describe("elapsed time", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const status = () => host.querySelector('[data-testid="gen-status"]')!.textContent ?? "";
    const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
    const running = (over: Partial<RenderLayer>) =>
      clip(layer({ hasPending: false, userKept: true, requestId: "request-two", ...over }));

    it("counts from the click through Submitting, Queued and Running, with no expected-time claim", async () => {
      // render_layer answers only after 3 s (a cold service spawn): the clock must already run.
      let answer: (() => void) | null = null;
      exec.mockImplementation((command: string) => command === "render_layer"
        ? new Promise<CommandResult>((resolve) => { answer = () => resolve({ ok: true, command, data: { requestId: "request-two", status: "queued" } }); })
        : Promise.resolve({ ok: true, command }));
      render(clip(layer({ hasPending: false, userKept: true, requestId: "request-one" })));
      expect(status()).toBe("Result kept");                               // baseline: no clock at rest

      await act(async () => { button("gen-render").click(); });
      expect(status()).toBe("Submitting · 0:00");
      tick(3000);
      expect(status()).toBe("Submitting · 0:03");
      await act(async () => { answer!(); });

      render(running({ status: "queued" }));
      expect(status(), "the clock started at the click, not when the job queued").toBe("Queued · 0:03");
      tick(20_000);
      expect(status()).toBe("Queued · 0:23");
      render(running({ status: "rendering" }));
      expect(status()).toBe("Running · 0:23");
      tick(61_000);
      expect(status()).toBe("Running · 1:24");
      expect(status()).not.toMatch(/usually|minute|expect|remaining/i);

      render(running({ status: "ready", hasPending: true }));
      expect(status()).toBe("Result ready to audition");
      tick(5000);
      expect(status()).toBe("Result ready to audition");
    });

    it("keeps the click-time clock across the drawer closing and reopening mid-render", async () => {
      exec.mockImplementation(async (command: string) => command === "render_layer"
        ? { ok: true, command, data: { requestId: "request-two", status: "queued" } }
        : { ok: true, command });
      render(clip(layer({ hasPending: false, userKept: true, requestId: "request-one" })));
      await act(async () => { button("gen-render").click(); });
      render(running({ status: "rendering" }));
      tick(9000);
      expect(status()).toBe("Running · 0:09");

      act(() => root.render(null));                                       // inspector closed
      tick(4000);
      render(running({ status: "rendering" }));                           // …and reopened
      expect(status()).toBe("Running · 0:13");
    });

    it("a render it did not start counts from when it was first seen", () => {
      render(running({ status: "rendering", requestId: "request-foreign" }));
      expect(status()).toBe("Running · 0:00");
      tick(2000);
      expect(status()).toBe("Running · 0:02");
    });

    it("first sight is stamped with the real time, not a clock left idle since mount", () => {
      render(running({ status: "ready", requestId: "request-old" }));   // idle for a minute
      tick(60_000);
      render(running({ status: "queued", requestId: "request-validate" }));
      expect(status()).toBe("Queued · 0:00");
      tick(4000);
      expect(status()).toBe("Queued · 0:04");
    });
  });

  // ── A13: name the out-of-date helper as the cause ─────────────────────────────────────
  it.each([false, undefined])("names the out-of-date Re-Imagine helper when the service is up but lacks direct render (%s)", (supported) => {
    useStore.setState({ explicitRenderDecision: supported, genServiceState: "ready" }); render();
    const line = host.querySelector('[data-testid="gen-service-unavailable"]')!.textContent ?? "";
    expect(line).toContain("The Re-Imagine helper in ~/Library/Application Support/Mosh/ReImagine/service is older than this Mosh (no direct render). Refresh it, then press Retry.");
  });

  it("keeps the service's own error and the SA3-missing copy for their own causes", () => {
    useStore.setState({ explicitRenderDecision: undefined, genServiceState: "error", genServiceError: "list_colors failed: connection refused" }); render();
    expect(host.querySelector('[data-testid="gen-service-unavailable"]')!.textContent).toContain("connection refused");
    expect(host.querySelector('[data-testid="gen-service-unavailable"]')!.textContent).not.toContain("older than this Mosh");

    act(() => root.render(null));
    useStore.setState({ explicitRenderDecision: true, sa3Available: false, genServiceState: "ready", genServiceError: null }); render();
    expect(host.querySelector('[data-testid="gen-service-unavailable"]')!.textContent).toContain("Local SA3 is unavailable");
  });
});
