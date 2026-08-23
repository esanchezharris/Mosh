import { describe, it, expect } from "vitest";
import { shouldShowAudioDeviceNotice } from "./AudioDeviceNotice";
import type { Snapshot } from "../types";

// AUD-017 — the banner is the ONLY thing that turns "no sound and no idea why" into a
// recoverable state, so its visibility rule gets pinned rather than eyeballed.
const snap = (audioDeviceError?: string) =>
  ({ session: { audioDeviceError } } as unknown as Snapshot);

const readinessSnap = (audioReady: boolean) =>
  ({ session: { audioReady } } as unknown as Snapshot);

describe("shouldShowAudioDeviceNotice", () => {
  it("shows when the backend reported a device error", () => {
    expect(shouldShowAudioDeviceNotice(snap("Audio device \"X\" did not open within 5.0s."))).toBe(true);
  });

  it("shows when the current device is not actually ready even without a latched startup error", () => {
    expect(shouldShowAudioDeviceNotice(readinessSnap(false))).toBe(true);
  });

  it("stays hidden on a healthy session", () => {
    expect(shouldShowAudioDeviceNotice(snap(undefined))).toBe(false);
    expect(shouldShowAudioDeviceNotice(snap(""))).toBe(false);
  });

  it("stays hidden with no snapshot at all (cold boot)", () => {
    expect(shouldShowAudioDeviceNotice(null)).toBe(false);
  });
});
