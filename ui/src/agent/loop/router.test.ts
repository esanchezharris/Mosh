import { describe, it, expect } from "vitest";
import { routeAsk } from "./router";

// The lane router's golden table — each row is how a producer actually asks.
// single = the cheap one-shot path; loop = plan/act/observe/repair.
const CASES: Array<[string, "single" | "loop"]> = [
  // stays single: one clear move
  ["mute the vocal", "single"],
  ["set the tempo to 128", "single"],
  ["pan the keys a bit right", "single"],
  ["drop the drums 3 dB", "single"],
  ["split the 808 clip at bar 3", "single"],
  // sequential clauses → loop
  ["mute the vocal then duck the drums", "loop"],
  ["set 90 bpm; lay a boom bap groove", "loop"],
  ["add a bus, next route the vocal into it", "loop"],
  // creative builds → loop
  ["build me a lofi sketch", "loop"],
  ["make a beat", "loop"],
  ["write a bassline", "loop"], // composing needs a clip + notes + the key — multi-step by nature
  ["give the keys a little melody idea, nothing fancy, keep it in key", "loop"],
  // vague taste → loop
  ["give the whole thing a better vibe", "loop"],
  ["make the mix feel wider", "loop"],
  ["make it faster", "loop"],
  // conjunction pileup → loop
  ["mute the vocal and solo the drums and pan the keys left", "loop"],
];

describe("routeAsk — the lane router golden table", () => {
  for (const [ask, lane] of CASES)
    it(`"${ask}" → ${lane}`, () => expect(routeAsk(ask)).toBe(lane));
});
