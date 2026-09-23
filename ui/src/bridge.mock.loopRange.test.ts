import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// Review fix 7: the engine applies loopStart/loopEnd whenever BOTH are present, independently of
// the `loop` flag (MoshOps::cmdSetTransport, MoshOps.TempoProject.cpp). The mock applied the
// range only inside `if ("loop" in args)`, which is why V3's + Drum beat had to send a `loop`
// flag it read from a possibly stale store (and could turn Loop back off).

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const transport = async () => (await mockSnapshot<Snapshot>()).transport;

describe("bridge.mock set_transport — the loop range mirrors MoshOps", () => {
  beforeEach(() => __resetMockForTests());

  it("applies {loopStart, loopEnd} with no loop flag, and leaves looping as it was", async () => {
    expect((await run("set_transport", { loop: false, loopStart: 0, loopEnd: 0 })).ok).toBe(true);
    expect((await run("set_transport", { loopStart: 2, loopEnd: 6 })).ok).toBe(true);
    let t = await transport();
    expect([t.looping, t.loopStart, t.loopEnd]).toEqual([false, 2, 6]);
    expect((await run("set_transport", { loop: true })).ok).toBe(true);
    expect((await run("set_transport", { loopStart: 1, loopEnd: 3 })).ok).toBe(true);
    t = await transport();
    expect([t.looping, t.loopStart, t.loopEnd]).toEqual([true, 1, 3]);   // still looping
  });

  it("keeps the flag-only and flag-with-range forms working", async () => {
    expect((await run("set_transport", { loop: true, loopStart: 4, loopEnd: 8 })).ok).toBe(true);
    let t = await transport();
    expect([t.looping, t.loopStart, t.loopEnd]).toEqual([true, 4, 8]);
    expect((await run("set_transport", { loop: false })).ok).toBe(true);
    t = await transport();
    expect([t.looping, t.loopStart, t.loopEnd]).toEqual([false, 4, 8]);  // the range stays
  });
});
