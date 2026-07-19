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

describe("catalog — Phase-A closure commands (coverage-audit additions)", () => {
  for (const c of ["delete_time_range", "insert_tempo_change", "remove_tempo_change",
                   "set_clip_warp", "reject_lyric_proposal", "list_builtins", "list_plugins"])
    it(`has ${c}`, () => expect(AGENT_COMMAND_MAP.has(c)).toBe(true));

  it("delete_time_range requires numeric start+end; ripple is an optional boolean", () => {
    expect(validateCommand("delete_time_range", { start: 4, end: 8 })).toBeNull();
    expect(validateCommand("delete_time_range", { start: 4, end: 8, ripple: true })).toBeNull();
    expect(validateCommand("delete_time_range", { start: 4 })).not.toBeNull();
    expect(validateCommand("delete_time_range", { start: "4", end: 8 })).not.toBeNull();
    expect(validateCommand("delete_time_range", { start: 4, end: 8, ripple: "yes" })).not.toBeNull();
  });
  it("delete_time_range warns about its all-tracks scope in the desc", () => {
    expect(AGENT_COMMAND_MAP.get("delete_time_range")!.desc).toMatch(/ALL tracks/);
  });
  it("insert_tempo_change requires time+bpm; curve optional", () => {
    expect(validateCommand("insert_tempo_change", { time: 8, bpm: 140 })).toBeNull();
    expect(validateCommand("insert_tempo_change", { time: 8, bpm: 140, curve: 0 })).toBeNull();
    expect(validateCommand("insert_tempo_change", { time: 8 })).not.toBeNull();
    expect(validateCommand("insert_tempo_change", { bpm: 140 })).not.toBeNull();
  });
  it("remove_tempo_change requires the map index", () => {
    expect(validateCommand("remove_tempo_change", { index: 1 })).toBeNull();
    expect(validateCommand("remove_tempo_change", {})).not.toBeNull();
  });
  it("trim_clip accepts the opt-in ripple flag", () => {
    expect(validateCommand("trim_clip", { clipId: "c1", start: 0, length: 2, ripple: true })).toBeNull();
    expect(validateCommand("trim_clip", { clipId: "c1", start: 0, length: 2, ripple: "yes" })).not.toBeNull();
  });
  it("set_clip_warp requires clipId + autoTempo; sourceBpm/detect/mode optional", () => {
    expect(validateCommand("set_clip_warp", { clipId: "c1", autoTempo: true })).toBeNull();
    expect(validateCommand("set_clip_warp", { clipId: "c1", autoTempo: true, detect: true })).toBeNull();
    expect(validateCommand("set_clip_warp", { clipId: "c1", autoTempo: true, sourceBpm: 87.5 })).toBeNull();
    expect(validateCommand("set_clip_warp", { clipId: "c1" })).not.toBeNull();
  });
  it("reject_lyric_proposal requires trackId + lineIndex", () => {
    expect(validateCommand("reject_lyric_proposal", { trackId: "t1", lineIndex: 0 })).toBeNull();
    expect(validateCommand("reject_lyric_proposal", { trackId: "t1" })).not.toBeNull();
  });
  it("list_builtins / list_plugins are argless read-only tools", () => {
    expect(validateCommand("list_builtins", {})).toBeNull();
    expect(validateCommand("list_plugins", {})).toBeNull();
  });
});
