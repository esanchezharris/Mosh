import { describe, expect, it } from "vitest";
import {
  contributionLabel, loopActionTarget, loopAvailable, loopPlaying, loopRecording,
  loopTarget, loopTargetLabel, LOOP_ACTIONS, type LoopAction,
} from "./loopPolicy";
import type { LoopContribution, LoopState } from "../types";

const part = (id: string, over: Partial<LoopContribution> = {}): LoopContribution =>
  ({ id, label: `Part ${id}`, keeper: false, rejected: false, ...over });

function loop(over: Partial<LoopState> = {}): LoopState {
  return {
    engaged: true,
    phase: "idle",
    leadTrackId: "11",
    takesTrackId: "12",
    transport: { recording: false, playing: false, positionSec: 0 },
    listening: { qn: 0, bar: 1, entryQn: null, leadQn: 8 },
    currentId: null,
    lastId: null,
    reviewId: null,
    auditionedId: null,
    contributions: [],
    phoneSeenMs: 0,
    blockReason: "",
    ...over,
  };
}

describe("loopTarget", () => {
  it("is the current pass while recording, whatever is selected", () => {
    const state = loop({
      transport: { recording: true, playing: true, positionSec: 4 },
      currentId: "p3", lastId: "p2", contributions: [part("p1"), part("p2")],
    });
    expect(loopTarget(state, "p1")).toBe("p3");
  });

  it("falls back selection → auditioned → last when stopped", () => {
    const parts = [part("p1"), part("p2")];
    expect(loopTarget(loop({ contributions: parts, auditionedId: "p2", lastId: "p1" }), "p1")).toBe("p1");
    expect(loopTarget(loop({ contributions: parts, auditionedId: "p2", lastId: "p1" }), null)).toBe("p2");
    expect(loopTarget(loop({ contributions: parts, auditionedId: null, lastId: "p1" }), null)).toBe("p1");
    expect(loopTarget(loop({ contributions: parts }), null)).toBeNull();
    // a selection that is not a contribution is not a target
    expect(loopTarget(loop({ contributions: parts }), "gone")).toBeNull();
  });

  it("has no target at all without a loop", () => {
    expect(loopTarget(null, "p1")).toBeNull();
    expect(loopTarget(undefined, "p1")).toBeNull();
  });
});

describe("loopAvailable", () => {
  const ctx = (over: Partial<{ loop: LoopState | null; selected: string | null; pending: boolean }> = {}) =>
    ({ loop: loop(), selected: null, pending: false, ...over });

  it("disables EVERY action, including stop, when the loop is not engaged", () => {
    const off = ctx({ loop: loop({ engaged: false }) });
    for (const action of LOOP_ACTIONS) expect(loopAvailable(action, off), action).toBe(false);
    const none = ctx({ loop: null });
    for (const action of LOOP_ACTIONS) expect(loopAvailable(action, none), action).toBe(false);
  });

  it("disables everything while the Mac says it cannot record", () => {
    const blocked = ctx({ loop: loop({ blockReason: "No audio device — recording is unavailable on this Mac" }) });
    for (const action of LOOP_ACTIONS) expect(loopAvailable(action, blocked), action).toBe(false);
  });

  it("keeps stop available while every other action is held by a pending request", () => {
    const busy = ctx({ pending: true, loop: loop({ lastId: "p1", contributions: [part("p1")] }) });
    expect(loopAvailable("stop", busy)).toBe(true);
    for (const action of LOOP_ACTIONS.filter((a) => a !== "stop")) {
      expect(loopAvailable(action, busy), action).toBe(false);
    }
  });

  it("gates record on not already recording, and play_all never", () => {
    expect(loopAvailable("record", ctx())).toBe(true);
    expect(loopAvailable("play_all", ctx())).toBe(true);
    const rec = ctx({ loop: loop({ transport: { recording: true, playing: true, positionSec: 1 } }) });
    expect(loopAvailable("record", rec)).toBe(false);
    expect(loopAvailable("play_all", rec)).toBe(true);
  });

  it("gates the cursor actions on a stopped transport", () => {
    const cursor: LoopAction[] = ["navigate", "home", "lead_in"];
    for (const action of cursor) expect(loopAvailable(action, ctx()), action).toBe(true);
    const playing = ctx({ loop: loop({ transport: { recording: false, playing: true, positionSec: 1 } }) });
    for (const action of cursor) expect(loopAvailable(action, playing), action).toBe(false);
    const rec = ctx({ loop: loop({ transport: { recording: true, playing: true, positionSec: 1 } }) });
    for (const action of cursor) expect(loopAvailable(action, rec), action).toBe(false);
  });

  it("gates hear on the current pass while recording and on an explicit selection otherwise", () => {
    const recNoPass = ctx({ loop: loop({ transport: { recording: true, playing: true, positionSec: 1 }, currentId: null }) });
    expect(loopAvailable("hear", recNoPass)).toBe(false);
    const recPass = ctx({ loop: loop({ transport: { recording: true, playing: true, positionSec: 1 }, currentId: "p9" }) });
    expect(loopAvailable("hear", recPass)).toBe(true);
    // stopped: an auditioned/last fallback is NOT enough — hear needs a pick
    const fallback = ctx({ loop: loop({ lastId: "p1", contributions: [part("p1")] }) });
    expect(loopAvailable("hear", fallback)).toBe(false);
    expect(loopAvailable("hear", { ...fallback, selected: "p1" })).toBe(true);
  });

  it("gates keep and again on having a target at all", () => {
    expect(loopAvailable("keep", ctx())).toBe(false);
    expect(loopAvailable("again", ctx())).toBe(false);
    const withTarget = ctx({ loop: loop({ lastId: "p1", contributions: [part("p1")] }) });
    expect(loopAvailable("keep", withTarget)).toBe(true);
    expect(loopAvailable("again", withTarget)).toBe(true);
  });
});

describe("loopActionTarget", () => {
  it("sends the selection for a stopped hear, the loop target for keep/again, nothing else", () => {
    const state = loop({ contributions: [part("p1"), part("p2")], lastId: "p2" });
    expect(loopActionTarget("hear", { loop: state, selected: "p1", pending: false })).toBe("p1");
    expect(loopActionTarget("keep", { loop: state, selected: null, pending: false })).toBe("p2");
    expect(loopActionTarget("again", { loop: state, selected: "p1", pending: false })).toBe("p1");
    expect(loopActionTarget("record", { loop: state, selected: "p1", pending: false })).toBeNull();
    expect(loopActionTarget("stop", { loop: state, selected: "p1", pending: false })).toBeNull();
    const rec = loop({ transport: { recording: true, playing: true, positionSec: 1 }, currentId: "p9" });
    expect(loopActionTarget("hear", { loop: rec, selected: "p1", pending: false })).toBe("p9");
  });
});

describe("labels", () => {
  it("names a part by what happened to it", () => {
    expect(contributionLabel(part("a", { label: "Part 1" }))).toBe("Part 1 · preserved");
    expect(contributionLabel(part("a", { label: "Part 1", keeper: true }))).toBe("Part 1 · kept");
    expect(contributionLabel(part("a", { label: "Part 1", rejected: true }))).toBe("Part 1 · preserved redo");
    // rejected wins over keeper, exactly as the pad renders it
    expect(contributionLabel(part("a", { label: "Part 1", keeper: true, rejected: true }))).toBe("Part 1 · preserved redo");
  });

  it("describes the target the buttons will act on", () => {
    expect(loopTargetLabel(loop({ transport: { recording: true, playing: true, positionSec: 1 } }), null))
      .toBe("current recording");
    expect(loopTargetLabel(loop({ contributions: [part("p1", { label: "Part 1", keeper: true })], lastId: "p1" }), null))
      .toBe("Part 1 · kept");
    expect(loopTargetLabel(loop(), null)).toBe("no part selected");
    expect(loopTargetLabel(null, null)).toBe("no part selected");
  });
});

describe("transport readers", () => {
  it("read the nested transport block the engine writes", () => {
    expect(loopRecording(loop({ transport: { recording: true, playing: true, positionSec: 0 } }))).toBe(true);
    expect(loopPlaying(loop({ transport: { recording: false, playing: true, positionSec: 0 } }))).toBe(true);
    expect(loopRecording(null)).toBe(false);
    expect(loopPlaying(undefined)).toBe(false);
  });
});
