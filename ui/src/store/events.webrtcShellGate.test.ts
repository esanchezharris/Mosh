import { afterEach, describe, expect, it, vi } from "vitest";
import { onWebrtcSignal } from "./events";
import { useSettings } from "../settings/store";
import { useVideo } from "../webrtc/useVideo";
import type { MoshEvent } from "../types";

// onWebrtcSignal is deliberately v2-only (plus the classic redesign): a shell with no video
// surface must not negotiate a peer connection. V3 has none, so under V3 the signal is
// dropped. This pins that decision from the V3 parity brief §2; widen it with a video room.
const signal = (): MoshEvent =>
  ({ type: "webrtc_signal", payload: { from: "peer-1", payload: { type: "offer", sdp: "v=0" } } }) as unknown as MoshEvent;

describe("onWebrtcSignal shell gate", () => {
  const original = useVideo.getState().onSignal;
  afterEach(() => {
    useVideo.setState({ onSignal: original });
    useSettings.getState().set("uiShell", "protools");
    useSettings.getState().set("redesignShell", false);
  });

  it("delivers under v2 (anti-vacuity: the spy is reachable at all)", () => {
    const spy = vi.fn();
    useVideo.setState({ onSignal: spy });
    useSettings.getState().set("uiShell", "v2");
    onWebrtcSignal(signal());
    expect(spy).toHaveBeenCalledWith("peer-1", { type: "offer", sdp: "v=0" });
  });

  it("drops under v3 and under protools", () => {
    for (const shell of ["v3", "protools"] as const) {
      const spy = vi.fn();
      useVideo.setState({ onSignal: spy });
      useSettings.getState().set("uiShell", shell);
      onWebrtcSignal(signal());
      expect(spy, shell).not.toHaveBeenCalled();
    }
  });
});
