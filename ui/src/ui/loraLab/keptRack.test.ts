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

  // The case that was broken: a library that already lists adapters. loadLoras kept
  // its first non-empty answer, so the refresh after Keep never ran and the new
  // adapter stayed invisible until the app restarted (the test above starts from an
  // EMPTY library, where the lazy fetch happens to run).
  it("shows the kept adapter even when the library already had adapters", async () => {
    const library = (names: string[]) => names.map((name) => ({ name, displayName: name, trigger: "", hint: "", valid: true, family: "library" }));
    useStore.setState({ availableLoras: library(["older-one"]), loraRetrying: false } as never);
    vi.spyOn(await import("../../bridge"), "executeCommand").mockImplementation(
      (async (req: { command: string }) => {
        if (req.command === "promote_lora_checkpoint") return { ok: true, data: { name: "keeper" } };
        if (req.command === "list_loras") return { ok: true, data: { loras: library(["older-one", "keeper"]) } };
        return { ok: true, data: {} };
      }) as never,
    );

    expect(await useStore.getState().promoteLabTake("ken-01@400", "keeper")).toBe(true);
    await flush();
    expect(useStore.getState().availableLoras.map((l) => l.name)).toEqual(["older-one", "keeper"]);
    useStore.setState({ availableLoras: [] } as never);
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

  // Membership is explicit: a slider dragged to 0 must not make its own row vanish
  // under the producer's hand (the registry skips a zero entry at render time anyway).
  it("adds at 70, removes on request, and keeps any typed value including 0 and negative", () => {
    const s = useStore.getState();
    s.addLabStack("ken");
    s.addLabStack("bro");
    useStore.getState().addLabStack("ken");                 // already there: unchanged
    expect(useStore.getState().labStack).toEqual([{ name: "ken", value: 70 }, { name: "bro", value: 70 }]);
    useStore.getState().setLabStackValue("ken", 0);
    useStore.getState().setLabStackValue("bro", -25.5);
    expect(useStore.getState().labStack).toEqual([{ name: "ken", value: 0 }, { name: "bro", value: -25.5 }]);
    useStore.getState().setLabStackValue("bro", Number.NaN);  // not a number: ignored
    expect(useStore.getState().labStack[1].value).toBe(-25.5);
    useStore.getState().removeLabStack("ken");
    expect(useStore.getState().labStack).toEqual([{ name: "bro", value: -25.5 }]);
  });

  it("allows overdrive past the slider — there is no clamp by owner call", () => {
    useStore.getState().setLabStackValue("ken", 340);
    expect(useStore.getState().labStack[0].value).toBe(340);
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

describe("LoRA Lab — the kept rack's controls", () => {
  it("adds a kept adapter at 70 with the shared strength control, and removes it", async () => {
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { KeptRack } = await import("./KeptRack");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    useStore.getState().resetLab();
    useStore.setState({ availableLoras: [
      { name: "ken", displayName: "Ken", trigger: "", hint: "", valid: true, family: "library" },
      { name: "run1@12", displayName: "run1@12", trigger: "", hint: "", valid: true, family: "lab" },
    ] } as never);
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(KeptRack)));
    const q = <T extends Element>(sel: string) => host.querySelector<T>(sel);

    act(() => q<HTMLButtonElement>(".lab-kept-toggle")!.click());
    expect(q('[data-testid="lab-kept-add-run1@12"]'), "a lab checkpoint is not a kept adapter").toBeNull();
    act(() => q<HTMLButtonElement>('[data-testid="lab-kept-add-ken"]')!.click());
    expect(useStore.getState().labStack).toEqual([{ name: "ken", value: 70 }]);
    const slider = q<HTMLInputElement>('[data-testid="lab-kept-strength-ken"] input[type="range"]');
    expect(slider?.value).toBe("70");
    expect(slider?.max).toBe("200");
    act(() => q<HTMLButtonElement>('button[aria-label="Remove Ken from the stack"]')!.click());
    expect(useStore.getState().labStack).toEqual([]);
    expect(q('[data-testid="lab-kept-add-ken"]')).not.toBeNull();

    act(() => root.unmount()); host.remove();
    useStore.setState({ availableLoras: [] } as never);
  });
});
