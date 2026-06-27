// Pure arg-shaper for the Export form (G1: range/section + delay-tail policy).
// Keeps the seam clean — the returned object is handed verbatim to
// exec("export_audio", …); no Tracktion/audio concepts leak into the view.
//
// Range selection: "full" (default, whole edit) or "loop" (the transport's current
// loop region — the backend reads it live so the form never has to round-trip the
// numbers). Tail policy: includeTail extends the render past the range end by
// tailSeconds so delay/reverb tails ring out. Both keys are OMITTED when not in use
// so a plain mixdown export carries exactly the args it did before this feature.

import type { ExportFormat } from "../types";

export type ExportRange = "full" | "loop";

export type ExportArgsInput = {
  format: ExportFormat;
  bitDepth: number;
  range: ExportRange;
  includeTail: boolean;
  tailSeconds: number;
  loop: { loopStart: number; loopEnd: number };
};

export type ExportArgs = {
  format: ExportFormat;
  bitDepth: number;
  range?: ExportRange;
  start?: number;
  end?: number;
  includeTail?: boolean;
  tailSeconds?: number;
};

export function buildExportArgs(input: ExportArgsInput): ExportArgs {
  const args: ExportArgs = { format: input.format, bitDepth: input.bitDepth };
  if (input.range === "loop") args.range = "loop";
  if (input.includeTail) {
    args.includeTail = true;
    args.tailSeconds = input.tailSeconds;
  }
  return args;
}

// True when the loop region is a usable, non-empty selection (so the form can disable
// "Loop region" when there's nothing looped yet).
export function hasLoopRegion(loop: { loopStart: number; loopEnd: number }): boolean {
  return loop.loopEnd > loop.loopStart + 1e-6;
}
