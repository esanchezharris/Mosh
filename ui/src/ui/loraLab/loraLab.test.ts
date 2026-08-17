// The LoRA Lab's audition loop, against the real bridge mock.
//
// Two behaviours here are not obvious and would each be shipped-and-wrong
// without a test, because both LOOK fine in a quick manual try:
//
//   1. A take that finishes rendering must only start playing if it is STILL
//      the cued one. Renders take long enough that moving on before one lands
//      is the normal case, not an edge case — and the failure mode is audio
//      starting over whatever you are currently listening to, which reads as a
//      bug in playback rather than in cueing.
//
//   2. Re-auditioning an already-rendered take must NOT re-submit. A/B
//      comparison only works if switching is immediate, and the backend would
//      cache-hit anyway — so a re-submit is invisible in the result and visible
//      only as a delay, which is exactly the kind of regression that survives.
//
// Plus the guard that the baseline is a real, distinct render target: "is this
// better?" has no answer without the stock model to compare against.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { BASELINE_KEY, renderKey } from "../../store/loraLab";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("LoRA Lab — audition loop", () => {
  beforeEach(() => {
    useStore.getState().resetLab();
    useStore.setState({ labPrompt: "rage trap instrumental, distorted 808", labSeed: 7 } as never);
  });

  it("renders a take through render_lora_take with the adapter at full strength", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string; args: Record<string, unknown> }) => {
        calls.push(req);
        if (req.command === "render_lora_take")
          return { ok: true, data: { takeId: "abc123", status: "rendering" } };
        return { ok: true, data: {} };
      }) as never,
    );

    await useStore.getState().auditionLabTake("ken-run@600");

    const render = calls.find((c) => c.command === "render_lora_take");
    expect(render, "no render was submitted").toBeTruthy();
    expect(render!.args.adapters).toEqual([{ name: "ken-run@600", value: 100 }]);
    expect(render!.args.prompt).toBe("rage trap instrumental, distorted 808");
    expect(render!.args.seed).toBe(7);
    // No source clip selected → the arg is absent entirely, not sent as null/"".
    expect("sourceClipId" in render!.args).toBe(false);
    expect(useStore.getState().labRenders["ken-run@600"].status).toBe("rendering");
  });

  it("sends an EMPTY stack for the baseline — the stock model is a real take", async () => {
    // The comparison has to be renderable through the same path, or "better than
    // base" is a judgement against something never actually heard.
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string; args: Record<string, unknown> }) => {
        calls.push(req);
        return { ok: true, data: { takeId: "base1", status: "rendering" } };
      }) as never,
    );

    await useStore.getState().auditionLabTake(null);

    const render = calls.find((c) => c.command === "render_lora_take")!;
    expect(render.args.adapters).toEqual([]);
    expect(renderKey(null)).toBe(BASELINE_KEY);
    expect(useStore.getState().labRenders[BASELINE_KEY]).toBeTruthy();
  });

  it("refuses to render with no prompt — a take needs a question to answer", async () => {
    useStore.setState({ labPrompt: "   " } as never);
    const spy = vi.spyOn(await import("../../bridge"), "executeCommand")
      .mockImplementation((async () => ({ ok: true, data: {} })) as never);
    await useStore.getState().auditionLabTake("ken-run@600");
    expect(spy).not.toHaveBeenCalled();
  });

  it("replays an already-rendered take WITHOUT re-submitting", async () => {
    const calls: string[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string; args: Record<string, unknown> }) => {
        calls.push(req.command);
        return { ok: true, data: { takeId: "t1", status: "ready", outputWav: "/mock/t1.wav" } };
      }) as never,
    );

    await useStore.getState().auditionLabTake("ken-run@600");
    expect(calls.filter((c) => c === "render_lora_take")).toHaveLength(1);
    expect(useStore.getState().labRenders["ken-run@600"].status).toBe("ready");

    calls.length = 0;
    await useStore.getState().auditionLabTake("ken-run@600");
    expect(calls, "re-audition re-submitted instead of replaying from disk")
      .toEqual(["audition_file"]);
  });

  it("plays a finished take only while it is still cued", async () => {
    const played: string[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string; args: Record<string, unknown> }) => {
        if (req.command === "audition_file") played.push(String(req.args.path));
        if (req.command === "render_lora_take")
          return { ok: true, data: { takeId: "slow1", status: "rendering" } };
        return { ok: true, data: {} };
      }) as never,
    );

    await useStore.getState().auditionLabTake("ken-run@600");
    // The producer moves on while it renders — the normal case at these durations.
    useStore.getState().setLabCued("ken-run@1200");
    useStore.getState().onLabTakeEvent({ takeId: "slow1", status: "ready", outputWav: "/mock/slow1.wav" });
    await flush();

    expect(useStore.getState().labRenders["ken-run@600"].status).toBe("ready");
    expect(played, "an abandoned take started playing over the current one").toEqual([]);

    // ...and when it IS still cued, it does play.
    useStore.getState().setLabCued("ken-run@600");
    useStore.getState().onLabTakeEvent({ takeId: "slow1", status: "ready", outputWav: "/mock/slow1.wav" });
    await flush();
    expect(played, "gate never opens — the play path is dead, not conditional")
      .toEqual(["/mock/slow1.wav"]);
  });

  it("records a failed render as an error instead of a silent no-op", async () => {
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) =>
        req.command === "render_lora_take"
          ? { ok: false, error: "generative service unavailable" }
          : { ok: true, data: {} }) as never,
    );
    await useStore.getState().auditionLabTake("ken-run@600");
    const r = useStore.getState().labRenders["ken-run@600"];
    expect(r.status).toBe("error");
    expect(r.error).toContain("service");
  });

  it("dismissal hides a take without deleting anything", async () => {
    // ~20 minutes of compute per take, and the round's central finding was that
    // the take you nearly binned was sometimes the good one. Dismissal must stay
    // recoverable, and must never reach the backend.
    const calls: string[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) => { calls.push(req.command); return { ok: true, data: {} }; }) as never,
    );

    useStore.setState({
      labTakes: [{ name: "ken-run@600", step: 600, isFinal: false, landedAt: 1 }],
    } as never);
    useStore.getState().dismissLabTake("ken-run@600");
    expect(useStore.getState().labDismissed).toEqual(["ken-run@600"]);
    expect(useStore.getState().labTakes, "dismissal removed the take itself").toHaveLength(1);
    expect(calls, "dismissal talked to the backend").toEqual([]);

    useStore.getState().restoreLabTakes();
    expect(useStore.getState().labDismissed).toEqual([]);
  });
});
