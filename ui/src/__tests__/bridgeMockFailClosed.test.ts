import { describe, it, expect, beforeEach } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import type { CommandResult, Snapshot } from "../types";

// AL-017 — the dev-mock backend must be fail-closed. A MUTATING command the mock does
// not model used to fall through to `default: return ok(command)` — a SILENT fake
// success that made the dev/e2e UI look like it worked while nothing changed, hiding
// real UI-test gaps (paste_clip is the canonical example). The mock now errors on any
// unmodeled command, EXCEPT a small allowlist of intentional native-only / read-only
// passthroughs the dev UI degrades around gracefully.

describe("bridge.mock fail-closed default (AL-017)", () => {
  beforeEach(() => __resetMockForTests());

  it("rejects an unmodeled MUTATING command instead of faking success", async () => {
    const res = await mockExecute<CommandResult>({ command: "paste_clip", args: {} });
    expect(res.ok).toBe(false);
    expect(res.command).toBe("paste_clip");
    expect(res.error, "the error should name the offending command").toContain("paste_clip");
  });

  it("rejects a completely unknown command", async () => {
    const res = await mockExecute<CommandResult>({ command: "totally_unmodeled_op", args: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("does not mutate session state when an unmodeled command is rejected", async () => {
    const before = await mockSnapshot<Snapshot>();
    const res = await mockExecute<CommandResult>({
      command: "paste_clip",
      args: { trackId: before.tracks[0]?.id, start: 0, clip: { id: "x" } },
    });
    expect(res.ok).toBe(false);
    const after = await mockSnapshot<Snapshot>();
    expect(after).toEqual(before); // nothing landed
  });

  it("keeps intentional native-only / read-only passthroughs succeeding", async () => {
    for (const command of ["rescan_plugins", "recover_session", "discard_recovery", "import_clip_data"]) {
      const res = await mockExecute<CommandResult>({ command, args: {} });
      expect(res.ok, `${command} should still no-op-succeed (graceful degrade)`).toBe(true);
    }
  });

  it("still dispatches a modeled command normally (regression sanity)", async () => {
    const res = await mockExecute<CommandResult<{ trackId: string }>>({
      command: "create_track",
      args: { name: "Modeled" },
    });
    expect(res.ok).toBe(true);
    expect(res.data?.trackId).toBeTruthy();
  });
});
