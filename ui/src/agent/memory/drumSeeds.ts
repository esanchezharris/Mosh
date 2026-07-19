// M4 (Phase-B memory lane) — a small, tasteful set of built-in drum-pattern seed cards
// (source:"seed"), so pattern-library retrieval has something to offer on day one even
// before a producer has saved anything of their own. NEVER written to disk — hydrate.ts
// splices these in at READ time only, when the real global drum_pattern store is empty
// (mirrors knowledge.ts's own "bundled, not persisted" posture for its card set).
//
// Every pattern string here is asserted parseable by drumSeeds.test.ts (parseDrumPattern
// round-trips it without error) — a seed that doesn't parse would silently vanish from
// retrieval (patternCandidate's flat-weighting still works on garbage text, but
// renderPatternCard's verbatim-replay path is worthless if add_drum_pattern would reject
// it), so that test is load-bearing, not decorative.

import type { DrumPatternCard } from "./patternCards";

export const DRUM_PATTERN_SEEDS: readonly DrumPatternCard[] = [
  {
    name: "Boom-bap",
    pattern: "kick: X.......x.x.....; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.",
    stepsPerBar: 16,
    bars: 1,
    tags: ["boom-bap", "hip-hop", "classic"],
    bpmRange: [85, 95],
    source: "seed",
    uses: 0,
  },
  {
    name: "Trap",
    pattern: "kick: X......x..x.....; clap: ........x.......; hat: xxxxxxxxxxxxxxxx",
    stepsPerBar: 16,
    bars: 1,
    tags: ["trap", "808", "hi-hats"],
    bpmRange: [130, 150],
    source: "seed",
    uses: 0,
  },
  {
    name: "House four-on-the-floor",
    pattern: "kick: x...x...x...x...; clap: ....x.......x...; openhat: ..x...x...x...x.",
    stepsPerBar: 16,
    bars: 1,
    tags: ["house", "four-on-the-floor", "dance"],
    bpmRange: [122, 128],
    source: "seed",
    uses: 0,
  },
  {
    name: "Lofi swing",
    pattern: "kick: X.........x.....; snare: ........x.......; hat: ..x...x...x...x.",
    stepsPerBar: 16,
    bars: 1,
    tags: ["lofi", "swing", "laid-back"],
    bpmRange: [70, 90],
    source: "seed",
    uses: 0,
  },
  {
    name: "Reggaeton dembow",
    pattern: "kick: x......x..x.....; snare: ..x...x...x...x.; hat: x.x.x.x.x.x.x.x.",
    stepsPerBar: 16,
    bars: 1,
    tags: ["reggaeton", "dembow", "latin"],
    bpmRange: [90, 100],
    source: "seed",
    uses: 0,
  },
  {
    name: "Drum & bass break",
    pattern: "kick: x.......x.x.....; snare: ....x.......x...; hat: x.xxx.xxx.xxx.xx",
    stepsPerBar: 16,
    bars: 1,
    tags: ["dnb", "breakbeat", "fast"],
    bpmRange: [160, 175],
    source: "seed",
    uses: 0,
  },
];
