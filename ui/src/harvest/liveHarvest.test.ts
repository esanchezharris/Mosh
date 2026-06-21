import { describe, it, expect } from "vitest";
import { harvest } from "./harvester";
import { collectFresh, liveReport } from "./liveHarvest";

// A synthetic live session with three tagged turns:
//   T1 clean         — create_track (ok, replays clean)
//   T2 contract-fail — an unknown command (live ok, but not in the agent allowlist
//                      → replay validate fails); the live↔mock contract has drifted
//   T3 engine-fail   — set_track_volume returned ok:false in the live run (engine
//                      rejected it)
const L = (o: Record<string, unknown>) => JSON.stringify(o);
const LOG = [
  L({ ts: 1, seq: 1, command: "batch_begin", args: { name: "t1", turn_id: "T1", utterance: "make a bass track", source: "brain_chat" }, ok: true, undoable: false }),
  L({ ts: 1, seq: 2, command: "create_track", args: { name: "Bass", type: "audio" }, ok: true, undoable: true }),
  L({ ts: 1, seq: 3, command: "batch_end", args: {}, ok: true, undoable: false }),
  L({ ts: 2, seq: 4, command: "batch_begin", args: { name: "t2", turn_id: "T2", utterance: "do something weird", source: "brain_chat" }, ok: true, undoable: false }),
  L({ ts: 2, seq: 5, command: "frobnicate", args: {}, ok: true, undoable: true }),
  L({ ts: 2, seq: 6, command: "batch_end", args: {}, ok: true, undoable: false }),
  L({ ts: 3, seq: 7, command: "batch_begin", args: { name: "t3", turn_id: "T3", utterance: "turn it up", source: "voice" }, ok: true, undoable: false }),
  L({ ts: 3, seq: 8, command: "set_track_volume", args: { trackId: "nonexistent", db: 3 }, ok: false, error: "no such track", undoable: false }),
  L({ ts: 3, seq: 9, command: "batch_end", args: {}, ok: true, undoable: false }),
].join("\n");

describe("liveReport", () => {
  it("classifies turns into clean / engine-failure / contract-failure with offending commands", async () => {
    const tuples = await harvest(LOG, { logPath: "x" });
    expect(tuples).toHaveLength(3);
    const r = liveReport(tuples);

    expect(r.total).toBe(3);
    expect(r.clean).toBe(1); // T1 only

    // T3: the live engine rejected set_track_volume (ok:false)
    const eng = r.engineFailures.find((f) => f.turnId === "T3");
    expect(eng).toBeTruthy();
    expect(eng!.commands.join(" ")).toMatch(/set_track_volume/);
    expect(r.engineFailures.some((f) => f.turnId === "T2")).toBe(false); // T2 applied clean live

    // T2: unknown command → replay/allowlist drift (contract failure)
    const con = r.contractFailures.find((f) => f.turnId === "T2");
    expect(con).toBeTruthy();
    expect(con!.commands).toContain("frobnicate");
  });
});

describe("collectFresh", () => {
  it("returns only unseen turnIds and dedupes across repeated harvests", async () => {
    const tuples = await harvest(LOG, { logPath: "x" });
    const seen = new Set<string>();
    expect(collectFresh(tuples, seen).map((t) => t.turnId)).toEqual(["T1", "T2", "T3"]);
    // a re-harvest of the same (unchanged) log yields nothing new
    const again = await harvest(LOG, { logPath: "x" });
    expect(collectFresh(again, seen)).toHaveLength(0);
  });
});
