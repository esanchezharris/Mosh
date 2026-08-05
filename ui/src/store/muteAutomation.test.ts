// CAP-AUT-006 — the 30 Hz "mute_automation" rail's store handler.
//
// The load-bearing bit is that the map is REBUILT, not merged. The backend sends the full
// set of automated tracks every tick and one final empty payload when the last curve is
// deleted; a merging handler would leave that track stuck lit forever with no way for the
// user to work out why, since the thing driving it no longer exists.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onMuteAutomation } from "./events";
import { useStore } from "../store";
import { __resetMockForTests, __emitMockEvent } from "../bridge.mock";
import type { MoshEvent } from "../types";

const ev = (tracks: unknown): MoshEvent =>
  ({ type: "mute_automation", payload: { tracks } }) as unknown as MoshEvent;

describe("onMuteAutomation (CAP-AUT-006)", () => {
  it("maps the payload to trackId -> currently-muted", () => {
    const set = vi.fn();
    onMuteAutomation(ev([{ id: "a", muted: true }, { id: "b", muted: false }]), set);
    expect(set).toHaveBeenCalledWith({ muteAutomation: { a: true, b: false } });
  });

  it("REBUILDS rather than merges — an emptied payload clears a deleted curve", () => {
    const set = vi.fn();
    onMuteAutomation(ev([]), set);
    expect(set).toHaveBeenCalledWith({ muteAutomation: {} });
    // A merging handler would have produced a non-empty object here; that is the whole
    // reason the backend bothers to send one last empty tick on the falling edge.
    expect(Object.keys((set.mock.calls[0][0] as { muteAutomation: object }).muteAutomation)).toHaveLength(0);
  });

  it("a track dropping out of the set stops being automated", () => {
    const set = vi.fn();
    onMuteAutomation(ev([{ id: "a", muted: true }, { id: "b", muted: true }]), set);
    onMuteAutomation(ev([{ id: "a", muted: true }]), set);
    expect(set).toHaveBeenLastCalledWith({ muteAutomation: { a: true } });
  });

  it("coerces the flag, so a truthy-but-not-boolean payload cannot leak through", () => {
    const set = vi.fn();
    onMuteAutomation(ev([{ id: "a", muted: 1 }]), set);
    expect(set).toHaveBeenCalledWith({ muteAutomation: { a: true } });
  });

  it("tolerates a payload with no tracks array at all", () => {
    const set = vi.fn();
    onMuteAutomation({ type: "mute_automation", payload: {} } as unknown as MoshEvent, set);
    expect(set).toHaveBeenCalledWith({ muteAutomation: {} });
  });
});

// The handler above is only half the wiring: store.ts's dispatcher has to ROUTE
// "mute_automation" to it. Nothing else in this file would notice if that `else if`
// branch were dropped — the component test sets the store directly and the handler test
// calls onMuteAutomation by hand, so both stay green with the rail unplugged. This drives
// a real event through the real dispatcher.
describe("mute_automation reaches the store through the real dispatcher", () => {
  beforeEach(() => {
    __resetMockForTests();
    useStore.setState({ muteAutomation: {} } as never);
    useStore.getState().init();
  });

  it("an emitted event lands in store.muteAutomation", () => {
    __emitMockEvent("mute_automation", { tracks: [{ id: "z9", muted: true }] });
    expect(useStore.getState().muteAutomation).toEqual({ z9: true });
  });

  it("a later empty event clears it again", () => {
    __emitMockEvent("mute_automation", { tracks: [{ id: "z9", muted: true }] });
    __emitMockEvent("mute_automation", { tracks: [] });
    expect(useStore.getState().muteAutomation).toEqual({});
  });
});
