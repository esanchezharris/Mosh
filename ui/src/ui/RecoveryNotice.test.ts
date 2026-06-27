import { describe, it, expect, beforeEach } from "vitest";
import { shouldShowRecoveryNotice } from "./RecoveryNotice";
import { useStore } from "../store";
import type { Snapshot } from "../types";

function snapWith(recoveryAvailable?: boolean): Snapshot {
  return { schemaVersion: 1, session: { recoveryAvailable } } as unknown as Snapshot;
}

describe("A2 crash-recovery notice", () => {
  beforeEach(() => useStore.setState({ recoveryDismissed: false }));

  it("hidden when the prior session exited cleanly", () => {
    expect(shouldShowRecoveryNotice(snapWith(undefined), false)).toBe(false);
    expect(shouldShowRecoveryNotice(null, false)).toBe(false);
  });

  it("shown on an unclean prior exit, until dismissed", () => {
    expect(shouldShowRecoveryNotice(snapWith(true), false)).toBe(true);
    expect(shouldShowRecoveryNotice(snapWith(true), true)).toBe(false);
  });

  it("dismissRecovery flips the UI-local flag", () => {
    expect(useStore.getState().recoveryDismissed).toBe(false);
    useStore.getState().dismissRecovery();
    expect(useStore.getState().recoveryDismissed).toBe(true);
  });
});
