import { describe, it, expect } from "vitest";
import { routeAsk } from "./router";

// The lane router's golden table — each row is how a producer actually asks.
// loop = plan/act/observe/repair. "single" is NOT a cheaper LLM route: by the time
// routeAsk runs, the fast path and the studio skills have already declined, so a
// "single" verdict ends the turn as a HUH (AgentComposer's studio_skill_unsupported
// tail). Read every "single" row below as "we deliberately do not serve this yet".
const CASES: Array<[string, "single" | "loop"]> = [
  // stays single: one clear move the deterministic lanes above already own
  ["mute the vocal", "single"],
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
  // tempo → loop. No lane above the router carries a tempo rule (fastPath's RULES
  // table and session-control's anchored phrases are both tempo-free), so a "single"
  // verdict here is a refusal of a thing we can plainly do. Comparative, relative and
  // absolute phrasings all have to land in the same lane or the capability is a
  // coin flip on wording. NOTE these are routeAsk verdicts in isolation: the fast
  // path now claims the tightly-anchored NUMERIC forms ("set the tempo to 128")
  // before the router is ever consulted, so in the app those reach set_tempo without
  // an API call. The rows stay because routeAsk must still catch what the fast path
  // declines — "set the tempo to something faster", a fuzzier numeric phrasing, or a
  // tempo ask riding along with other work.
  ["make it faster", "loop"],
  ["make it slower", "loop"],
  ["speed it up", "loop"],
  ["speed this up", "loop"],
  ["can you speed it up", "loop"],
  ["speed up the track", "loop"],
  ["slow it down", "loop"],
  ["slow down", "loop"],
  ["make it quicker", "loop"],
  ["pick up the pace", "loop"],
  ["half time", "loop"],
  ["double time", "loop"],
  ["set the tempo to 128", "loop"],
  ["change the tempo to 140", "loop"],
  ["bring the tempo up", "loop"],
  ["drop the tempo", "loop"],
  ["128 bpm", "loop"],
  ["bump it to 140 bpm", "loop"],
  // conjunction pileup → loop
  ["mute the vocal and solo the drums and pan the keys left", "loop"],
];

describe("routeAsk — the lane router golden table", () => {
  for (const [ask, lane] of CASES)
    it(`"${ask}" → ${lane}`, () => expect(routeAsk(ask)).toBe(lane));
});
