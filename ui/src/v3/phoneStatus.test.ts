import { describe, expect, it } from "vitest";
import { phoneStatusLine } from "./phoneStatus";
import type { RemotePairingInfo } from "../bridge";
import type { LoopContribution, LoopState } from "../types";

const NOW = 1_700_000_000_000;

const part = (id: string, label: string): LoopContribution =>
  ({ id, label, keeper: false, rejected: false });

function loop(over: Partial<LoopState> = {}): LoopState {
  return {
    engaged: true,
    phase: "idle",
    transport: { recording: false, playing: false, positionSec: 0 },
    listening: { qn: 0, bar: 1, entryQn: null, leadQn: 8 },
    currentId: null, lastId: null, reviewId: null, auditionedId: null,
    contributions: [],
    phoneSeenMs: 0,
    blockReason: "",
    ...over,
  };
}

const pairing: RemotePairingInfo = {
  host: "192.168.1.80", port: 47873, token: "a".repeat(64), expiresAtMs: NOW + 60_000,
  pairingUrl: "mosh://pair?payload=MOCK",
  webUrl: "http://192.168.1.80:47873/web?payload=MOCK",
  padUrl: `http://192.168.1.80:47873/pad#token=${"a".repeat(64)}`,
};

describe("phoneStatusLine", () => {
  it("names the part the phone is on while it is recording", () => {
    const state = loop({
      phoneSeenMs: NOW - 500,
      transport: { recording: true, playing: true, positionSec: 6 },
      currentId: "p3",
      contributions: [part("p1", "Part 1"), part("p2", "Part 2"), part("p3", "Part 3")],
    });
    expect(phoneStatusLine(state, pairing, NOW)).toBe("Phone connected · Part 3 recording");
  });

  it("falls back to the activity when no part is current", () => {
    const playing = loop({ phoneSeenMs: NOW - 10, transport: { recording: false, playing: true, positionSec: 2 }, phase: "playing" });
    expect(phoneStatusLine(playing, pairing, NOW)).toBe("Phone connected · playing");
    const idle = loop({ phoneSeenMs: NOW - 10, phase: "idle" });
    expect(phoneStatusLine(idle, pairing, NOW)).toBe("Phone connected · idle");
  });

  it("drops back to the pairing line once the phone has been quiet for three seconds", () => {
    const stale = loop({ phoneSeenMs: NOW - 3001, transport: { recording: true, playing: true, positionSec: 1 }, currentId: "p1",
      contributions: [part("p1", "Part 1")] });
    expect(phoneStatusLine(stale, pairing, NOW)).toBe("Phone pad ready · scan the QR");
    // …and the boundary itself still counts as connected (anti-off-by-one)
    const edge = loop({ ...stale, phoneSeenMs: NOW - 2999 });
    expect(phoneStatusLine(edge, pairing, NOW)).toBe("Phone connected · Part 1 recording");
  });

  it("never claims a connection from a phoneSeenMs the host has never written", () => {
    expect(phoneStatusLine(loop({ phoneSeenMs: 0 }), pairing, NOW)).toBe("Phone pad ready · scan the QR");
    expect(phoneStatusLine(loop({ phoneSeenMs: undefined }), pairing, NOW)).toBe("Phone pad ready · scan the QR");
  });

  it("says nothing at all with neither a pairing nor a phone", () => {
    expect(phoneStatusLine(loop(), null, NOW)).toBeNull();
    expect(phoneStatusLine(null, null, NOW)).toBeNull();
    expect(phoneStatusLine(null, undefined, NOW)).toBeNull();
    // a live phone still reports even if the pairing has since been stopped
    expect(phoneStatusLine(loop({ phoneSeenMs: NOW - 100 }), null, NOW)).toBe("Phone connected · idle");
  });
});
