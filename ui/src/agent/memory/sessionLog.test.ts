import { describe, it, expect, beforeEach } from "vitest";
import { recordSessionCommand, getSessionLog, clearSessionLog, __resetSessionLogForTests } from "./sessionLog";

describe("sessionLog", () => {
  beforeEach(() => __resetSessionLogForTests());

  it("starts empty", () => {
    expect(getSessionLog()).toEqual([]);
  });

  it("records commands oldest-first, with args and ok status", () => {
    recordSessionCommand("create_track", { name: "Hats" }, true);
    recordSessionCommand("delete_track", { trackId: "1" }, false);
    expect(getSessionLog()).toEqual([
      { command: "create_track", args: { name: "Hats" }, ok: true },
      { command: "delete_track", args: { trackId: "1" }, ok: false },
    ]);
  });

  it("clearSessionLog empties the buffer", () => {
    recordSessionCommand("create_track", {}, true);
    clearSessionLog();
    expect(getSessionLog()).toEqual([]);
  });

  it("caps at 300 entries, FIFO (drops the oldest)", () => {
    for (let i = 0; i < 305; i++) recordSessionCommand("set_track_volume", { i }, true);
    const log = getSessionLog();
    expect(log).toHaveLength(300);
    expect(log[0].args).toEqual({ i: 5 });        // the 5 oldest were dropped
    expect(log[299].args).toEqual({ i: 304 });
  });
});
