import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// new_project must start a genuinely blank edit (matching the native backend's
// createEmptyEdit) — not silently no-op. Without this, File → New looks inert in
// dev and the producer-loop e2e can't start from a clean slate.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("mock new_project — faithful empty edit", () => {
  beforeEach(() => __resetMockForTests());

  it("clears all tracks and resets transport to a blank session", async () => {
    expect((await snap()).tracks.length).toBeGreaterThan(0); // seeded session has tracks
    const r = await exec("new_project");
    expect(r.ok).toBe(true);
    const s = await snap();
    expect(s.tracks).toEqual([]);
    expect(s.transport.position).toBe(0);
    expect(s.transport.playing).toBe(false);
    // session scaffolding stays valid so the UI still renders the (empty) arrangement
    expect(s.session.tempo).toBeGreaterThan(0);
    expect(s.session.sampleRate).toBeGreaterThan(0);
  });

  it("cannot be undone — New starts a fresh history", async () => {
    await exec("create_track", { name: "Scratch" });
    expect((await snap()).tracks.length).toBeGreaterThan(0);
    await exec("new_project");
    expect((await snap()).tracks).toEqual([]);
    const u = await exec("undo");
    expect((u.data as { undone?: boolean }).undone).toBe(false);
    expect((await snap()).tracks).toEqual([]);
  });
});
