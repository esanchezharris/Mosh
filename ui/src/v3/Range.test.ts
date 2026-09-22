import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rangePct } from "./Range";

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "shell.css"), "utf8");

describe("V3 slider", () => {
  it("maps a value to its fill fraction, clamped", () => {
    expect(rangePct(-60, -60, 6)).toBe(0);
    expect(rangePct(6, -60, 6)).toBe(1);
    expect(rangePct(-27, -60, 6)).toBeCloseTo(0.5, 6);
    expect(rangePct(0.35, 0, 1)).toBeCloseTo(0.35, 6);
    expect(rangePct(99, 0, 1)).toBe(1);
    expect(rangePct(-5, 0, 1)).toBe(0);
    expect(rangePct(1, 1, 1)).toBe(0);           // degenerate range: no fill rather than NaN
    expect(rangePct(Number.NaN, 0, 1)).toBe(0);
  });
  it("draws .rng without the browser knob: appearance none, a --pct fill, a cap the height of the line", () => {
    const thumb = css.match(/\.v3-shell input\[type="range"\]\.rng::-webkit-slider-thumb\s*\{([^}]*)\}/);
    expect(thumb).not.toBeNull();
    expect(thumb![1]).toMatch(/appearance:\s*none/);
    expect(thumb![1]).not.toMatch(/border-radius:\s*50%/);
    expect(thumb![1]).toMatch(/height:\s*4px/);
    const track = css.match(/\.v3-shell input\[type="range"\]\.rng::-webkit-slider-runnable-track\s*\{([^}]*)\}/);
    expect(track![1]).toMatch(/var\(--pct/);
    expect(track![1]).toMatch(/height:\s*4px/);
  });
});
