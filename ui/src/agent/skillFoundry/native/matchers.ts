// Skill Foundry Slice B, Task 6 — deterministic utterance -> slots matchers for the two
// native handlers (takeCycleV1, explicitBalanceV1) that expect an already-filled
// `slots.action` rather than parsing the utterance themselves (sessionControlV1 and
// loadNamedPluginV1 already do their own parsing — `matchSessionControlActionV1` in
// sessionControl.ts and `pluginQueryV1` in loadNamedPlugin.ts). The runtime (runtime.ts)
// calls all four skills' matchers in a fixed order to deterministically resolve BOTH which
// skill an utterance names AND its slot values, with no model call, exactly like the
// existing deterministic fast paths (fastPath.ts) do today for the commands they cover.
//
// DESIGN DECISION: this is a deliberately SMALL, closed phrase/regex vocabulary — not the
// full "retrieve top three, then ask the brain for structured slots" pipeline spec 9.2
// describes for the general case. Extending coverage (more paraphrases, brain-assisted
// slot filling for a name/level the deterministic matcher misses) is future work; this
// slice ships the deterministic core the four journeys need to be reachable at all.

import type { TakeCycleActionV1 } from "./takeCycle";
import type { ExplicitBalanceActionV1 } from "./explicitBalance";

export function matchTakeCycleActionV1(utterance: string): TakeCycleActionV1 | null {
  const t = utterance.trim().toLowerCase().replace(/[?!.]+$/, "");
  if (/^(record( a take)?|start recording|hit record)$/.test(t)) return "start";
  if (/^(stop( recording)?)$/.test(t)) return "stop";
  if (/^(try (it |that )?again|record again|one more take|again)$/.test(t)) return "again";
  if (/^(next take|audition next|later take|the next one)$/.test(t)) return "audition_next";
  if (/^(previous take|audition previous|earlier take|last take|the previous one)$/.test(t)) return "audition_previous";
  if (/^keep(\s+(it|that|this take))?$/.test(t)) return "keep";
  return null;
}

export type ExplicitBalanceMatchV1 = {
  readonly action: ExplicitBalanceActionV1;
  readonly db?: number;
  readonly trackName?: string;
};

/** A pronoun/deictic target ("it", "this", "that track") means "use the selection" —
 *  returns undefined so the handler falls through to `selected_track`. */
function namedTargetOrSelected(text: string): string | undefined {
  const normalized = text.trim().toLowerCase();
  if (["it", "this", "that", "this track", "that track", "the selected track"].includes(normalized)) return undefined;
  return text.trim();
}

export function matchExplicitBalanceUtteranceV1(utterance: string): ExplicitBalanceMatchV1 | null {
  const t = utterance.trim();

  let m = t.match(/^(?:set|put)\s+(.+?)\s+(?:to|at)\s+(-?\d+(?:\.\d+)?)\s*db$/i);
  if (m) return { action: "set_level", trackName: namedTargetOrSelected(m[1]!), db: Number(m[2]) };

  m = t.match(/^mute\s+(.+)$/i);
  if (m) return { action: "mute", trackName: namedTargetOrSelected(m[1]!) };
  if (/^mute(\s+(it|this|that))?$/i.test(t)) return { action: "mute" };

  m = t.match(/^unmute\s+(.+)$/i);
  if (m) return { action: "unmute", trackName: namedTargetOrSelected(m[1]!) };
  if (/^unmute(\s+(it|this|that))?$/i.test(t)) return { action: "unmute" };

  m = t.match(/^solo\s+(.+)$/i);
  if (m) return { action: "solo", trackName: namedTargetOrSelected(m[1]!) };
  if (/^solo(\s+(it|this|that))?$/i.test(t)) return { action: "solo" };

  return null;
}
