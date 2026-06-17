import { describe, it, expect } from "vitest";
import { validateCommand, AGENT_COMMAND_MAP } from "./commands";

describe("catalog — performer-mode commands exposed", () => {
  for (const c of ["set_transport", "arm_track", "stop_recording", "set_input_monitor", "undo", "redo", "save", "list_takes", "set_current_take", "keep_take"])
    it(`has ${c}`, () => expect(AGENT_COMMAND_MAP.has(c)).toBe(true));

  it("set_transport accepts an action string (+ optional loop/position)", () => {
    expect(validateCommand("set_transport", { action: "record" })).toBeNull();
    expect(validateCommand("set_transport", { action: "toggle", loop: true })).toBeNull();
  });
  it("arm_track requires trackId + armed:boolean", () => {
    expect(validateCommand("arm_track", { trackId: "t1", armed: true })).toBeNull();
    expect(validateCommand("arm_track", { trackId: "t1" })).not.toBeNull();
    expect(validateCommand("arm_track", { trackId: "t1", armed: "yes" })).not.toBeNull();
  });
  it("stop_recording / undo / save validate", () => {
    expect(validateCommand("stop_recording", {})).toBeNull();
    expect(validateCommand("undo", {})).toBeNull();
    expect(validateCommand("save", {})).toBeNull();
  });
  it("take commands require their ids", () => {
    expect(validateCommand("list_takes", { clipId: "c1" })).toBeNull();
    expect(validateCommand("set_current_take", { clipId: "c1", takeIndex: 1 })).toBeNull();
    expect(validateCommand("set_current_take", { clipId: "c1" })).not.toBeNull();
    expect(validateCommand("keep_take", { clipId: "c1" })).toBeNull();
  });
});
