import { describe, expect, it } from "vitest";
import { coordTasks, coordTasksForClip, splitTimeIsInterior, type ClipDef } from "./offsetCoords";

const OFFSET: ClipDef = { name: "Keys", start: 4, length: 8 };   // 4–12s (the eval clip)
const OFFSET2: ClipDef = { name: "Bass", start: 6, length: 6 };  // 6–12s

describe("coordTasksForClip", () => {
  it("split times are STRICTLY inside the offset clip (so the gold clean-applies)", () => {
    const tasks = coordTasksForClip(OFFSET, 1).filter((t) => t.op === "split_clip");
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(splitTimeIsInterior(OFFSET, t.args.time)).toBe(true);
      // corrective signal: reading the time as clip-relative (start + time) gives a
      // DIFFERENT answer than the absolute gold — that's what the offset teaches.
      expect(OFFSET.start + t.args.time).not.toBe(t.args.time);
    }
  });
  it("the batch contains the HARD contrastive case: a split where add-offset lands OUTSIDE", () => {
    // relative-misread (start + time) escapes the clip for at least one task across
    // several seeds — the exact failure the eval's Keys clip exposed.
    let hard = false;
    for (let s = 1; s <= 12 && !hard; s++)
      for (const t of coordTasksForClip(OFFSET, s).filter((x) => x.op === "split_clip"))
        if (OFFSET.start + t.args.time >= OFFSET.start + OFFSET.length) hard = true;
    expect(hard).toBe(true);
  });
  it("emits split + move + trim for a clip", () => {
    const ops = new Set(coordTasksForClip(OFFSET, 7).map((t) => t.op));
    expect(ops).toContain("split_clip");
    expect(ops).toContain("move_clip");
    expect(ops).toContain("trim_clip");
  });
  it("move/trim coordinates are non-zero (offset-sensitive) and valid", () => {
    for (const t of coordTasksForClip(OFFSET, 3)) {
      if (t.op === "move_clip") expect(t.args.start).toBeGreaterThan(0);
      if (t.op === "trim_clip") { expect(t.args.start).toBeGreaterThan(0); expect(t.args.length).toBeGreaterThan(0); }
    }
  });
  it("requests name the clip and carry the number", () => {
    for (const t of coordTasksForClip(OFFSET, 5)) {
      expect(t.request).toContain("Keys");
      expect(t.request).toMatch(/\d/);
    }
  });
  it("is deterministic by seed", () => {
    expect(JSON.stringify(coordTasksForClip(OFFSET, 42))).toBe(JSON.stringify(coordTasksForClip(OFFSET, 42)));
    expect(JSON.stringify(coordTasksForClip(OFFSET, 42))).not.toBe(JSON.stringify(coordTasksForClip(OFFSET, 43)));
  });
  it("a length-1 clip yields no split (no strictly-interior integer) but still move/trim", () => {
    const tiny: ClipDef = { name: "Blip", start: 5, length: 1 };
    const tasks = coordTasksForClip(tiny, 1);
    expect(tasks.some((t) => t.op === "split_clip")).toBe(false);
    expect(tasks.some((t) => t.op === "move_clip")).toBe(true);
  });
});

describe("coordTasks", () => {
  it("varies phrasing/coords across clips and is deterministic", () => {
    const a = coordTasks([OFFSET, OFFSET2], 100);
    const b = coordTasks([OFFSET, OFFSET2], 100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // distinct clips produce distinct requests (not a single memorised template)
    const reqs = new Set(a.map((t) => t.request));
    expect(reqs.size).toBeGreaterThan(3);
    // every split across both clips is interior to ITS clip
    for (const t of a.filter((x) => x.op === "split_clip")) {
      const clip = t.clipName === "Keys" ? OFFSET : OFFSET2;
      expect(splitTimeIsInterior(clip, t.args.time)).toBe(true);
    }
  });
});
