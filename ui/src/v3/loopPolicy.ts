import type { LoopContribution, LoopState } from "../types";

// MOSHI-LOOP availability, desktop side. A port of the phone pad's own policy
// (ui/src/phonepad/src/policy.ts) over the engine's LoopState, so a button is live on
// the Booth exactly when the same button is live on the phone. Pure: no store, no DOM.
//
// Two differences from the pad's version, both structural rather than editorial:
//   · there is no `connected` input — the Booth is the host, so the gate is the loop
//     being engaged and this Mac being able to record at all (`blockReason`);
//   · the engine nests recording/playing under `transport` (the phone endpoint flattens
//     them before they reach a pad), so the readers below do that one hop.

export const LOOP_ACTIONS = [
  "record", "keep", "again", "hear", "play_all", "stop", "navigate", "home", "lead_in",
] as const;
export type LoopAction = (typeof LOOP_ACTIONS)[number];

export type LoopContext = {
  loop: LoopState | null | undefined;
  /** The contribution the producer picked in the Booth's list, if any. */
  selected: string | null;
  /** A command of ours is in flight. Everything but Stop waits for it. */
  pending: boolean;
};

export const loopRecording = (loop: LoopState | null | undefined): boolean =>
  loop?.transport?.recording === true;
export const loopPlaying = (loop: LoopState | null | undefined): boolean =>
  loop?.transport?.playing === true;

/** What Keep / Again would act on: the pass being recorded, else the picked one, else the
 *  one last auditioned, else the last one captured. */
export function loopTarget(loop: LoopState | null | undefined, selected: string | null): string | null {
  if (!loop) return null;
  if (loopRecording(loop)) return loop.currentId;
  const selection = loop.contributions.find((part) => part.id === selected);
  return selection?.id ?? loop.auditionedId ?? loop.lastId ?? null;
}

export function contributionLabel(part: LoopContribution): string {
  return `${part.label} · ${part.rejected ? "preserved redo" : part.keeper ? "kept" : "preserved"}`;
}

export function loopTargetLabel(loop: LoopState | null | undefined, selected: string | null): string {
  if (loopRecording(loop)) return "current recording";
  const id = loopTarget(loop, selected);
  const part = loop?.contributions.find((candidate) => candidate.id === id);
  return part ? contributionLabel(part) : "no part selected";
}

export function loopAvailable(action: LoopAction, context: LoopContext): boolean {
  const loop = context.loop;
  // Nothing at all — including Stop — without a loop this Mac can actually drive.
  if (!loop || !loop.engaged || (loop.blockReason ?? "") !== "") return false;
  if (action === "stop") return true;
  if (context.pending) return false;
  switch (action) {
    case "record": return !loopRecording(loop);
    case "play_all": return true;
    case "navigate": case "home": case "lead_in": return !loopRecording(loop) && !loopPlaying(loop);
    // While rolling, Review means "the pass I am singing"; stopped, it needs a real pick —
    // the auditioned/last fallback would review something nobody asked for.
    case "hear": return loopRecording(loop) ? loop.currentId !== null : context.selected !== null;
    case "again": case "keep": return loopTarget(loop, context.selected) !== null;
  }
}

/** The `targetId` the command carries, or null when it takes none. */
export function loopActionTarget(action: LoopAction, context: LoopContext): string | null {
  if (action === "hear" && !loopRecording(context.loop)) return context.selected;
  if (action === "keep" || action === "again" || action === "hear")
    return loopTarget(context.loop, context.selected);
  return null;
}
