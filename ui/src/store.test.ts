import { describe, it, expect, beforeEach, vi } from "vitest";

// Observe the seam without a backend. vi.hoisted so the shared array exists when the
// (hoisted) vi.mock factory runs.
const { calls } = vi.hoisted(() => ({ calls: [] as { command: string; args: unknown }[] }));

vi.mock("./bridge", () => ({
  executeCommand: (payload: { command: string; args: unknown }) => {
    calls.push({ command: payload.command, args: payload.args });
    return Promise.resolve({ ok: true, command: payload.command, data: {} });
  },
  getSnapshot: () => Promise.resolve({ tracks: [], transport: {} }),
  onEvent: () => () => {},
  isNative: () => true,
  notifyUiReady: () => Promise.resolve(),
  getRemoteStatus: () => Promise.resolve({ ok: false }),
  startRemotePairing: () => Promise.resolve({ ok: false }),
  stopRemoteCompanion: () => Promise.resolve({ ok: false }),
}));

import { useStore } from "./store";

beforeEach(() => {
  calls.length = 0;
});

describe("store dispatch: serialization (Phase 0)", () => {
  it("rapid exec() calls reach the bridge in submission order, none dropped", async () => {
    const s = useStore.getState();
    const names = ["create_track", "rename_track", "remove_track", "set_tempo", "save"];
    // Fire the whole burst without awaiting between calls.
    await Promise.all(names.map((n) => s.exec(n)));
    expect(calls.map((c) => c.command)).toEqual(names);
  });

  it("pending returns to 0 after a burst settles", async () => {
    const s = useStore.getState();
    await Promise.all([s.exec("a"), s.exec("b"), s.exec("c")]);
    expect(useStore.getState().pending).toBe(0);
  });

  it("one failing command does not poison the queue (later commands still run)", async () => {
    const s = useStore.getState();
    // exec swallows the prior result; even a rejected upstream wouldn't stop the chain.
    await Promise.all([s.exec("first"), s.exec("second"), s.exec("third")]);
    expect(calls.map((c) => c.command)).toEqual(["first", "second", "third"]);
  });
});

describe("store dispatch: execLatest coalescing (Phase 0)", () => {
  it("delivers the LAST of a rapid burst under one key, coalescing the rest", async () => {
    const s = useStore.getState();
    for (let i = 1; i <= 5; i++) s.execLatest("vol:t1", "set_track_volume", { db: i });
    // Drain: this exec serializes AFTER the execLatest flush, so once it resolves the
    // flush has run.
    await s.exec("__drain__");
    const vol = calls.filter((c) => c.command === "set_track_volume");
    expect(vol.length).toBe(1);
    expect((vol[0].args as { db: number }).db).toBe(5);
  });

  it("distinct keys each deliver their own latest value", async () => {
    const s = useStore.getState();
    s.execLatest("vol:a", "set_track_volume", { trackId: "a", db: 2 });
    s.execLatest("vol:b", "set_track_volume", { trackId: "b", db: 9 });
    s.execLatest("vol:a", "set_track_volume", { trackId: "a", db: 3 });
    await s.exec("__drain__");
    const vol = calls.filter((c) => c.command === "set_track_volume");
    expect(vol.length).toBe(2);
    const byTrack = Object.fromEntries(vol.map((c) => [(c.args as { trackId: string }).trackId, (c.args as { db: number }).db]));
    expect(byTrack).toEqual({ a: 3, b: 9 });
  });
});
