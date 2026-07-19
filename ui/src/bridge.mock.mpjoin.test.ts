import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, __resetMockForTests } from "./bridge.mock";
import type { CommandResult } from "./types";

// #42 (EDGECASE_SWEEP_V2_2026-07-18) — the mock's mp_join_session used to accept ANY
// code, so the join-failure path (relay lookup miss on native) was untestable and the
// UI could ship with no inline failure feedback. The mock now fails deterministically
// for codes outside its own "MOCK-ROOM-…" format. Documented mock⇄native divergence:
// native fails via the relay; the mock fails on format — the RESULT shape (ok:false +
// error string) is the contract under test.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

describe("mp_join_session failure path via the mock bridge", () => {
  beforeEach(() => __resetMockForTests());

  it("join with an unknown code fails with an error naming the room", async () => {
    const r = await exec("mp_join_session", { code: "JUNK-CODE-999" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no such room/i);
    expect(r.error).toContain("JUNK-CODE-999");
  });

  it("join with a MOCK-ROOM code still succeeds", async () => {
    const r = await exec("mp_join_session", { code: "MOCK-ROOM-abcdef0123456789" });
    expect(r.ok).toBe(true);
  });

  it("create session is unaffected", async () => {
    const r = await exec("mp_create_session", {});
    expect(r.ok).toBe(true);
  });
});
