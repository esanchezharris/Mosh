import { describe, expect, it } from "vitest";
import { DEFAULT_ORDER, load, moveInOrder, orderForTiles, parse, sanitizeOrder, save, serialize, TILES } from "./layout";
import type { Button } from "./types";

describe("sanitizeOrder", () => {
  it("drops unknowns, appends missing, dedupes", () => {
    expect(sanitizeOrder(["stop", "bogus", "stop", "keep"])).toEqual([
      "stop",
      "keep",
      "again",
      "hear",
      "marker",
      "record",
    ]);
  });
  it("returns the full default set for junk input", () => {
    expect(sanitizeOrder(null)).toEqual(TILES);
    expect(sanitizeOrder("nope")).toEqual(TILES);
  });
});

describe("orderForTiles", () => {
  it("keeps a stored marker from reappearing in Ableton mode", () => {
    // Given
    const layout = parse('{"order":["marker","stop","keep","again","hear","record"],"navPos":"bottom"}');

    // When
    const order = orderForTiles(layout, ["keep", "again", "hear", "record", "stop"]);

    // Then
    expect(order).toEqual(["stop", "keep", "again", "hear", "record"]);
  });
});

describe("moveInOrder", () => {
  const base: Button[] = ["keep", "again", "hear", "marker", "record", "stop"];
  it("moves a tile to a new index (reflow)", () => {
    expect(moveInOrder(base, "stop", 0)).toEqual(["stop", "keep", "again", "hear", "marker", "record"]);
    expect(moveInOrder(base, "record", 2)).toEqual(["keep", "again", "record", "hear", "marker", "stop"]);
  });
  it("clamps the target index and is a no-op for unknown ids", () => {
    expect(moveInOrder(base, "keep", 99)).toEqual(["again", "hear", "marker", "record", "stop", "keep"]);
    expect(moveInOrder(base, "zzz" as Button, 0)).toEqual(base);
  });
  it("does not mutate the input", () => {
    const copy = [...base];
    moveInOrder(base, "stop", 0);
    expect(base).toEqual(copy);
  });
});

describe("parse / serialize", () => {
  it("parse(null) → default order, bottom nav", () => {
    expect(parse(null)).toEqual({ order: DEFAULT_ORDER, navPos: "bottom" });
  });
  it("round-trips through serialize", () => {
    const layout = { order: ["stop", "record", "keep", "again", "hear", "marker"] as Button[], navPos: "top" as const };
    expect(parse(serialize(layout))).toEqual(layout);
  });
  it("sanitizes a partial/corrupt stored order", () => {
    expect(parse('{"order":["stop","junk"],"navPos":"top"}')).toEqual({
      order: ["stop", "keep", "again", "hear", "marker", "record"],
      navPos: "top",
    });
    expect(parse("{not json")).toEqual({ order: DEFAULT_ORDER, navPos: "bottom" });
  });
});

describe("load / save", () => {
  it("persists and reloads through a Storage-like shim", () => {
    const mem: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => {
        mem[k] = v;
      },
    };
    save(storage, { order: ["hear", "record", "keep", "again", "marker", "stop"], navPos: "top" });
    expect(load(storage)).toEqual({ order: ["hear", "record", "keep", "again", "marker", "stop"], navPos: "top" });
  });
});
