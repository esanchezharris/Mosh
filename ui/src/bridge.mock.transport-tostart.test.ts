import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, mockOnEvent, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// set_transport {action:"to_start"} must reset the playhead to 0 — mirroring the native
// backend (MoshOps.cpp: to_start → transport.setPosition(TimePosition())), exactly as
// to_end jumps to the edit length. Without this the dev mock leaves the playhead put,
// so File/keymap "return to start" looks inert in the WebView and e2e.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("mock set_transport — to_start resets the playhead", () => {
  beforeEach(() => __resetMockForTests());

  it("returns the playhead to position 0 after a prior seek", async () => {
    // seek somewhere non-zero first
    await exec("set_transport", { position: 8 });
    expect((await snap()).transport.position).toBe(8);

    const r = await exec("set_transport", { action: "to_start" });
    expect(r.ok).toBe(true);
    expect((await snap()).transport.position).toBe(0);
  });

  it("emits a transport event carrying the reset position", async () => {
    await exec("set_transport", { position: 12 });

    type Ev = { type: string; payload?: { position?: number } };
    let last: Ev["payload"];
    const off = mockOnEvent("mosh_event", (e) => {
      const ev = e as Ev;
      if (ev.type === "transport") last = ev.payload;
    });
    await exec("set_transport", { action: "to_start" });
    off();

    expect(last).toBeDefined();
    expect(last?.position).toBe(0);
  });
});
