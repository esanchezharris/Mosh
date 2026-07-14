// Open Lanes (v3) — per-track hue assignment. The design identifies a track by the COLOR
// of its content (waveform / notes / steps), not by a chrome spine — so every track needs a
// stable, desaturated hue that reads on obsidian. Hues are OKLCH-equalized by eye (same rough
// lightness/chroma, varying hue only) so no lane shouts over another. Cycled by track index so
// the assignment is deterministic and stable across snapshots (a reorder carries the hue with
// the track object, since we key off its live index at render time).

const HUES = [
  "#c79b69", // warm tan
  "#9f9dd8", // periwinkle
  "#d48f96", // rose
  "#6fb697", // sea green
  "#7fb0d0", // sky
  "#d0b06f", // gold
  "#b98fd0", // violet
  "#8fd0b8", // mint
] as const;

export function trackHue(index: number): string {
  return HUES[((index % HUES.length) + HUES.length) % HUES.length];
}
