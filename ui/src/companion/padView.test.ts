import { describe, expect, it } from "vitest";
import { mountPadTiles } from "./padView";

describe("mountPadTiles", () => {
  it("omits MARKER from the Ableton DOM and layout", () => {
    // Given
    const grid = document.createElement("div");

    // When
    const tiles = mountPadTiles(grid, ["keep", "again", "hear", "record", "stop"], () => undefined);

    // Then
    expect(tiles.map((tile) => tile.dataset.id)).toEqual(["keep", "again", "hear", "record", "stop"]);
    expect(grid.querySelector('[data-id="marker"]')).toBeNull();
    expect(grid.textContent).not.toContain("MARKER");
  });

  it("keeps all six Mosh tiles available", () => {
    // Given
    const grid = document.createElement("div");

    // When
    mountPadTiles(grid, ["keep", "again", "hear", "marker", "record", "stop"], () => undefined);

    // Then
    expect(grid.querySelectorAll("button")).toHaveLength(6);
    expect(grid.textContent).toContain("MARKER");
  });
});
