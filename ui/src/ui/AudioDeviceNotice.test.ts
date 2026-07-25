import { describe, it, expect } from "vitest";
import { shouldShowAudioDeviceNotice } from "./AudioDeviceNotice";
import type { Snapshot } from "../types";

// AUD-017 — the banner is the ONLY thing that turns "no sound and no idea why" into a
// recoverable state, so its visibility rule gets pinned rather than eyeballed.
const snap = (audioDeviceError?: string) =>
  ({ session: { audioDeviceError } } as unknown as Snapshot);

describe("shouldShowAudioDeviceNotice", () => {
  it("shows when the backend reported a device error", () => {
    expect(shouldShowAudioDeviceNotice(snap("Audio device \"X\" did not open within 5.0s."), false)).toBe(true);
  });

  it("stays hidden on a healthy session", () => {
    expect(shouldShowAudioDeviceNotice(snap(undefined), false)).toBe(false);
    expect(shouldShowAudioDeviceNotice(snap(""), false)).toBe(false);
  });

  it("stays hidden with no snapshot at all (cold boot)", () => {
    expect(shouldShowAudioDeviceNotice(null, false)).toBe(false);
  });

  it("respects a dismissal", () => {
    expect(shouldShowAudioDeviceNotice(snap("boom"), true)).toBe(false);
  });
});
