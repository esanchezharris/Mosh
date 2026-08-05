import { describe, it, expect, beforeEach } from "vitest";
import { shouldShowRecoveryNotice, safeModeOffer } from "./RecoveryNotice";
import { useStore } from "../store";
import type { Snapshot } from "../types";

function snapWith(recoveryAvailable?: boolean): Snapshot {
  return { schemaVersion: 1, session: { recoveryAvailable } } as unknown as Snapshot;
}

function snapSession(session: Record<string, unknown>): Snapshot {
  return { schemaVersion: 1, session } as unknown as Snapshot;
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

describe("FS-T2 plugin-crash safe mode", () => {
  beforeEach(() => useStore.setState({ recoveryDismissed: false }));

  it("shows the notice when the app auto-degraded, even with nothing to replay", () => {
    // The load-time crash leaves NO session.running sentinel (it is written after the load),
    // so recoveryAvailable is absent. Gating the notice on it alone would hide the one
    // message that explains why the producer's plugins are missing.
    const snap = snapSession({ safeModeActive: true });
    expect(shouldShowRecoveryNotice(snap, false)).toBe(true);
    expect(shouldShowRecoveryNotice(snap, true)).toBe(false);
  });

  it("shows the notice when a crash suspect survived but the load then succeeded", () => {
    expect(shouldShowRecoveryNotice(snapSession({ pluginCrashSuspects: ["OTT"] }), false)).toBe(true);
  });

  it("offers safe mode when suspects exist and it is not already active", () => {
    const offer = safeModeOffer(snapSession({ pluginCrashSuspects: ["OTT", "Vital"] }));
    expect(offer.canOffer).toBe(true);
    expect(offer.active).toBe(false);
    expect(offer.suspects).toEqual(["OTT", "Vital"]);
  });

  it("does not re-offer safe mode while already in it", () => {
    const offer = safeModeOffer(snapSession({ safeModeActive: true, pluginCrashSuspects: ["OTT"] }));
    expect(offer.active).toBe(true);
    expect(offer.canOffer).toBe(false);
  });

  it("offers nothing on a clean session", () => {
    const offer = safeModeOffer(snapWith(undefined));
    expect(offer.canOffer).toBe(false);
    expect(offer.active).toBe(false);
    expect(offer.suspects).toEqual([]);
    expect(safeModeOffer(null).canOffer).toBe(false);
  });

  it("names the lone quarantine target only when there is exactly one", () => {
    // Blocklisting is permanent, so a guess across several candidates would quarantine
    // plugins the producer paid for. The backend decides; the UI must not re-derive it.
    expect(safeModeOffer(snapSession({ pluginCrashSuspects: ["OTT"], pluginQuarantineTarget: "OTT" })).quarantineTarget)
      .toBe("OTT");
    expect(safeModeOffer(snapSession({ pluginCrashSuspects: ["OTT", "Vital"], pluginQuarantineTarget: "" })).quarantineTarget)
      .toBe("");
  });
});
