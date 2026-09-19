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
    phoneConnected: false,
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
      phoneConnected: true,
      transport: { recording: true, playing: true, positionSec: 6 },
      currentId: "p3",
      contributions: [part("p1", "Part 1"), part("p2", "Part 2"), part("p3", "Part 3")],
    });
    expect(phoneStatusLine(state, pairing)).toBe("Phone connected · Part 3 recording");
  });

  it("falls back to the activity when no part is current", () => {
    const playing = loop({ phoneConnected: true, transport: { recording: false, playing: true, positionSec: 2 }, phase: "playing" });
    expect(phoneStatusLine(playing, pairing)).toBe("Phone connected · playing");
    const idle = loop({ phoneConnected: true, phase: "idle" });
    expect(phoneStatusLine(idle, pairing)).toBe("Phone connected · idle");
  });

  it("drops back to the pairing line the moment the engine stops calling the phone attached", () => {
    const gone = loop({
      phoneConnected: false,
      transport: { recording: true, playing: true, positionSec: 1 },
      currentId: "p1", contributions: [part("p1", "Part 1")],
    });
    expect(phoneStatusLine(gone, pairing)).toBe("Phone pad ready · scan the QR");
  });

  // ANTI-VACUITY. This is the exact shape the bug wore: `phoneSeenMs` is
  // Time::getMillisecondCounterHiRes() (ms since the Mac booted), so a value that LOOKS
  // like a fresh wall-clock stamp is not evidence of anything. Only the engine's own
  // verdict counts. A reader that fell back to the stamp would pass every test above and
  // fail this one.
  it("never infers a connection from phoneSeenMs, however recent the stamp looks", () => {
    const stamped = loop({
      phoneConnected: false, phoneSeenMs: NOW - 10,
      transport: { recording: true, playing: true, positionSec: 1 },
      currentId: "p1", contributions: [part("p1", "Part 1")],
    });
    expect(phoneStatusLine(stamped, pairing)).toBe("Phone pad ready · scan the QR");
    // …and the converse: a connected phone reports even with a stamp of zero, which is
    // what a host whose counter has just wrapped or a same-boot-tick poll both look like.
    expect(phoneStatusLine(loop({ phoneConnected: true, phoneSeenMs: 0 }), pairing))
      .toBe("Phone connected · idle");
  });

  it("never claims a connection from a backend that predates the field", () => {
    expect(phoneStatusLine(loop({ phoneConnected: undefined }), pairing)).toBe("Phone pad ready · scan the QR");
    // truthy-but-not-true must not pass either: the reader is `=== true`, not a coercion
    expect(phoneStatusLine(loop({ phoneConnected: 1 as unknown as boolean }), pairing))
      .toBe("Phone pad ready · scan the QR");
  });

  it("says nothing at all with neither a pairing nor a phone", () => {
    expect(phoneStatusLine(loop(), null)).toBeNull();
    expect(phoneStatusLine(null, null)).toBeNull();
    expect(phoneStatusLine(null, undefined)).toBeNull();
    // a live phone still reports even if the pairing has since been stopped
    expect(phoneStatusLine(loop({ phoneConnected: true }), null)).toBe("Phone connected · idle");
  });
});
