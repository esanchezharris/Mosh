import { describe, expect, it } from "vitest";
import type { RemotePairingInfo } from "../bridge";
import { formatCountdown, pairingView, STALLED_AFTER_MS, WARN_UNDER_MS, type PairingInput } from "./phonePairing";

const NOW = 1_800_000_000_000;

const pairing = (expiresAtMs: number): RemotePairingInfo => ({
  host: "192.168.1.5", port: 8765, token: "abc", expiresAtMs,
  pairingUrl: "mosh://pair", webUrl: "http://192.168.1.5:8765", padUrl: "http://192.168.1.5:8765/pad#token=abc",
});

const input = (over: Partial<PairingInput> = {}): PairingInput => ({
  requested: true,
  pairing: pairing(NOW + 299_000),
  error: null,
  everConnected: false,
  shownAtMs: NOW,
  nowMs: NOW,
  ...over,
});

describe("formatCountdown", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatCountdown(299_000)).toBe("4:59");
    expect(formatCountdown(300_000)).toBe("5:00");
    expect(formatCountdown(65_000)).toBe("1:05");
  });
  it("rounds a part second up, so it never shows 0:00 early", () => {
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(1)).toBe("0:01");
  });
  it("stops at 0:00", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });
});

describe("pairingView", () => {
  it("is idle until the singer asks for the code", () => {
    expect(pairingView(input({ requested: false, pairing: null })))
      .toEqual({ phase: "idle", countdown: "", warn: false, stalled: false, canRemint: false });
  });

  it("is starting while waiting for the server, with nothing to re-mint", () => {
    expect(pairingView(input({ pairing: null })))
      .toEqual({ phase: "starting", countdown: "", warn: false, stalled: false, canRemint: false });
    expect(pairingView(input({ pairing: undefined })).phase).toBe("starting");
  });

  it("is failed when the server did not start, offering a new attempt", () => {
    expect(pairingView(input({ pairing: null, error: "port in use" })))
      .toEqual({ phase: "failed", countdown: "", warn: false, stalled: false, canRemint: true });
  });

  it("shows the code with a countdown", () => {
    expect(pairingView(input())).toEqual({ phase: "showing", countdown: "4:59", warn: false, stalled: false, canRemint: true });
  });

  it("warns under a minute left, not at exactly a minute", () => {
    const under = pairingView(input({ pairing: pairing(NOW + WARN_UNDER_MS - 1_000) }));
    expect(under).toMatchObject({ phase: "showing", countdown: "0:59", warn: true });
    expect(pairingView(input({ pairing: pairing(NOW + WARN_UNDER_MS) })).warn).toBe(false);
  });

  it("is stalled a minute after the code was shown, not before", () => {
    expect(pairingView(input({ shownAtMs: NOW - STALLED_AFTER_MS })).stalled).toBe(true);
    expect(pairingView(input({ shownAtMs: NOW - STALLED_AFTER_MS + 1 })).stalled).toBe(false);
    expect(pairingView(input({ shownAtMs: null })).stalled).toBe(false);
  });

  it("is expired once the code lapses, at 0:00 with a warning and a new code on offer", () => {
    expect(pairingView(input({ pairing: pairing(NOW) })))
      .toEqual({ phase: "expired", countdown: "0:00", warn: true, stalled: false, canRemint: true });
    expect(pairingView(input({ pairing: pairing(NOW - 10_000), shownAtMs: NOW - 400_000 })))
      .toEqual({ phase: "expired", countdown: "0:00", warn: true, stalled: true, canRemint: true });
  });

  it("shows no countdown and never expires when expiresAtMs is 0", () => {
    expect(pairingView(input({ pairing: pairing(0) })))
      .toEqual({ phase: "showing", countdown: "", warn: false, stalled: false, canRemint: true });
  });

  it("latches connected, with no re-mint, whatever else the inputs say", () => {
    const connected = { phase: "connected", countdown: "", warn: false, stalled: false, canRemint: false };
    expect(pairingView(input({ everConnected: true }))).toEqual(connected);
    expect(pairingView(input({ everConnected: true, pairing: pairing(NOW - 1), shownAtMs: NOW - 400_000 }))).toEqual(connected);
    expect(pairingView(input({ everConnected: true, requested: false, pairing: null, error: "x" }))).toEqual(connected);
  });
});
