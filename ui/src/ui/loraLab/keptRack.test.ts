// Stage 3: Keep (promotion) and the kept-adapter stack.
//
// Three behaviours here are each one line away from being silently wrong, and
// none of them looks wrong in a manual try:
//
//   1. A REFUSED Keep ("that name is taken") must land on the row that caused
//      it, not vanish. Promotion refuses rather than overwrites — deliberately,
//      because a kept adapter is a decision — so the second checkpoint you try
//      to keep from one run is the FIRST thing a producer will hit, and if the
//      refusal is swallowed the button just appears dead.
//
//   2. The stack's render key must include values AND order. Adapters merge
//      sequentially, so [a@100, b@50] and [b@50, a@100] are different sounds;
//      a key of names alone makes them share one cached render, and the A/B
//      silently compares a take against itself.
//
//   3. Setting a stack value to 0 REMOVES the entry. The registry skips a
//      zero-strength adapter anyway, so leaving it in changes nothing audible
//      but makes the Σ readout claim adapters that are not in play.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { stackKey } from "../../store/loraLab";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("LoRA Lab — Keep", () => {
  beforeEach(() => {
    useStore.getState().resetLab();
    useStore.setState({ labPrompt: "rage trap, distorted 808", labSeed: 7 } as never);
    vi.restoreAllMocks();
  });

  it("promotes a take through promote_lora_checkpoint and refreshes the library", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string; args: Record<string, unknown> }) => {
        calls.push(req);
        if (req.command === "promote_lora_checkpoint") return { ok: true, data: { name: "keeper" } };
        if (req.command === "list_loras") return { ok: true, data: { loras: [] } };
        return { ok: true, data: {} };
      }) as never,
    );

    const okd = await useStore.getState().promoteLabTake("ken-01@400", "keeper");
    expect(okd).toBe(true);

    const promote = calls.find((c) => c.command === "promote_lora_checkpoint");
    expect(promote?.args).toMatchObject({ source: "ken-01@400", name: "keeper" });
    // Without this the new adapter is invisible until a reload and Keep looks inert.
    expect(calls.some((c) => c.command === "list_loras")).toBe(true);
    expect(useStore.getState().labKeepError["ken-01@400"]).toBeFalsy();
    expect(useStore.getState().labKeeping).toBeNull();
  });

  it("keeps a REFUSAL on the row that caused it, and does not claim success", async () => {
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) => {
        if (req.command === "promote_lora_checkpoint")
          return { ok: false, error: "a kept adapter named 'ken' already exists — pick another name" };
        return { ok: true, data: {} };
      }) as never,
    );

    const okd = await useStore.getState().promoteLabTake("ken-01@400", "ken");
    expect(okd).toBe(false);
    expect(useStore.getState().labKeepError["ken-01@400"]).toContain("already exists");
    // Not left spinning — the button must come back.
    expect(useStore.getState().labKeeping).toBeNull();
  });

  it("refuses an empty name without calling the backend", async () => {
    const calls: string[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) => { calls.push(req.command); return { ok: true, data: {} }; }) as never,
    );
    const okd = await useStore.getState().promoteLabTake("ken-01@400", "   ");
    expect(okd).toBe(false);
    expect(calls).not.toContain("promote_lora_checkpoint");
    expect(useStore.getState().labKeepError["ken-01@400"]).toBeTruthy();
  });
});

describe("LoRA Lab — the kept stack", () => {
  beforeEach(() => {
    useStore.getState().resetLab();
    useStore.setState({ labPrompt: "rage trap, distorted 808", labSeed: 7 } as never);
    vi.restoreAllMocks();
  });

  it("distinguishes stacks by value AND order", () => {
    const a = stackKey([{ name: "ken", value: 100 }, { name: "bro", value: 50 }]);
    const b = stackKey([{ name: "bro", value: 50 }, { name: "ken", value: 100 }]);
    const c = stackKey([{ name: "ken", value: 100 }, { name: "bro", value: 60 }]);
    expect(a).not.toBe(b);   // order changes the merge, so it changes the sound
    expect(a).not.toBe(c);   // so does strength
    expect(a).toBe(stackKey([{ name: "ken", value: 100 }, { name: "bro", value: 50 }]));
  });

  it("appends new entries in merge order and preserves position on a value change", () => {
    const s = useStore.getState();
    s.setLabStackValue("ken", 100);
    s.setLabStackValue("bro", 40);
    expect(useStore.getState().labStack.map((e) => e.name)).toEqual(["ken", "bro"]);
    // Re-ordering under the producer's hand would silently change the sound.
    useStore.getState().setLabStackValue("ken", 70);
    expect(useStore.getState().labStack).toEqual([
      { name: "ken", value: 70 }, { name: "bro", value: 40 },
    ]);
  });

  it("treats 0 as removal, not a zero-strength merge", () => {
    const s = useStore.getState();
    s.setLabStackValue("ken", 100);
    s.setLabStackValue("bro", 40);
    useStore.getState().setLabStackValue("ken", 0);
    expect(useStore.getState().labStack).toEqual([{ name: "bro", value: 40 }]);
  });

  it("allows overdrive above 100 — there is no clamp by owner call", () => {
    useStore.getState().setLabStackValue("ken", 140);
    expect(useStore.getState().labStack[0].value).toBe(140);
  });

  it("auditions the whole stack as ONE take, with the stack verbatim", async () => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string; args: Record<string, unknown> }) => {
        calls.push(req);
        if (req.command === "render_lora_take")
          return { ok: true, data: { takeId: "st1", status: "rendering" } };
        return { ok: true, data: {} };
      }) as never,
    );
    const s = useStore.getState();
    s.setLabStackValue("ken", 100);
    s.setLabStackValue("bro", 40);
    await useStore.getState().auditionLabStack();
    await flush();

    const r = calls.find((c) => c.command === "render_lora_take");
    expect(r?.args.adapters).toEqual([{ name: "ken", value: 100 }, { name: "bro", value: 40 }]);
    expect(r?.args.prompt).toBe("rage trap, distorted 808");
    const key = stackKey([{ name: "ken", value: 100 }, { name: "bro", value: 40 }]);
    expect(useStore.getState().labCued).toBe(key);
    expect(useStore.getState().labRenders[key]?.status).toBe("rendering");
  });

  it("does nothing with an empty stack or an empty prompt", async () => {
    const calls: string[] = [];
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) => { calls.push(req.command); return { ok: true, data: {} }; }) as never,
    );
    await useStore.getState().auditionLabStack();          // empty stack
    useStore.getState().setLabStackValue("ken", 100);
    useStore.setState({ labPrompt: "  " } as never);
    await useStore.getState().auditionLabStack();          // empty prompt
    expect(calls).not.toContain("render_lora_take");
  });
});
