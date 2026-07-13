import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests } from "../bridge.mock";
import { useStore } from "../store";
import { runAgentBatch } from "./executor";

describe("agent batch boundary failures", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not dispatch commands after batch_begin returns a failure envelope", async () => {
    const seen: string[] = [];
    const state = useStore.getState();
    const original = state.exec;
    vi.spyOn(state, "exec").mockImplementation(async (command, args) => {
      seen.push(command);
      if (command === "batch_begin")
        return { ok: false, command, error: "begin refused" };
      return original(command, args);
    });

    await expect(runAgentBatch("refused", [{ command: "set_transport", args: { action: "toggle" } }]))
      .rejects.toThrow("batch_begin failed: begin refused");
    expect(seen).toEqual(["batch_begin"]);
  });

  it("does not report success when batch_end returns a failure envelope", async () => {
    const track = useStore.getState().snapshot?.tracks[0];
    if (!track) throw new Error("fixture has no track");
    const seen: string[] = [];
    const state = useStore.getState();
    const original = state.exec;
    vi.spyOn(state, "exec").mockImplementation(async (command, args) => {
      seen.push(command);
      if (command === "batch_end")
        return { ok: false, command, error: "end refused" };
      return original(command, args);
    });

    await expect(runAgentBatch("bad end", [{
      command: "set_track_volume",
      args: { trackId: track.id, db: -3 },
    }])).rejects.toThrow("batch_end failed: end refused");
    expect(seen).toEqual(["batch_begin", "set_track_volume", "batch_end"]);
  });
});
