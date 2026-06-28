// The missing middle of the Rung-2 audio reward: turn a policy REPLY into a native
// `Mosh --run-script` program that renders to a WAV.
//
// Rung 1 scores a reply symbolically (gepa/metric.scoreReply, mock backend, no audio).
// Rung 2 scores it by RENDERED AUDIO: the caller prepends the task's startCommands,
// runs (startCommands + these commands + export_audio) through the native binary, and
// feeds the WAV to the teardown Reward. This module is the pure, deterministic seam
// that converts "model reply text" → "renderable command program". It deliberately does
// NOT touch the engine or do id-remapping (that's the render orchestrator's job, since
// it needs the live native snapshot) — keeping this unit pure and trivially testable.
//
// Empty / malformed reply → deferred (reward 0), mirroring clean-apply's "acts-shy" rule
// so the GRPO trainer's deferral tripwire fires identically across Rung 1 and Rung 2.

import { parseReply } from "../agent/brainCore";
import type { BoundCommand } from "../import/emit";

export type RenderProgram = {
  /** the policy's commands followed by an export_audio to `outWav`; empty when deferred */
  commands: BoundCommand[];
  /** true when the policy emitted no usable commands (the "acts-shy" failure) */
  deferred: boolean;
};

/** Default render window for the reward (seconds). Mirrors the teardown Oracle's
 *  `range_s` — short renders keep the reward loop cheap; full-length adds no signal. */
export const DEFAULT_EXPORT_SECONDS = 10;

/** Parse a policy reply into a run-script program that lands a WAV at `outWav`.
 *  Reuses `parseReply` (same catalog normalization as the live brain + the SFT eval),
 *  so the function-call-string form (`add_midi_clip("17")`) and the object form both
 *  collapse to `{command,args}`. Pure + deterministic. */
export function replyToProgram(content: string, outWav: string, format = "wav"): RenderProgram {
  const cmds = (parseReply(content).commands ?? []).map(
    (c): BoundCommand => ({ command: c.command, args: c.args ?? {} }),
  );
  if (cmds.length === 0) return { commands: [], deferred: true };
  return {
    commands: [...cmds, { command: "export_audio", args: { file: outWav, format } }],
    deferred: false,
  };
}
