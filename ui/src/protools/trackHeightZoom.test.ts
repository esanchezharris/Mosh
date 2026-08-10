import { describe, expect, it } from "vitest";
import { nextTrackHeightScale, scaledTrackHeights } from "./trackHeightZoom";

describe("Pro Tools proportional track-height zoom", () => {
  it("steps through bounded proportional levels", () => {
    expect(nextTrackHeightScale(1, -1)).toBe(0.75);
    expect(nextTrackHeightScale(1, 1)).toBe(1.25);
    expect(nextTrackHeightScale(0.75, -1)).toBe(0.75);
    expect(nextTrackHeightScale(1.5, 1)).toBe(1.5);
  });

  it("scales the main lane, playlist rows, and automation lane together", () => {
    expect(scaledTrackHeights(0.75)).toEqual({ main: 69, playlist: 20, automation: 21 });
    expect(scaledTrackHeights(1.25)).toEqual({ main: 115, playlist: 33, automation: 35 });
  });
});
