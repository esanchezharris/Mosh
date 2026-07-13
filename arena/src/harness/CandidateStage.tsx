import { HtmlCandidate } from "./HtmlCandidate";
import { GlslCandidate } from "./GlslCandidate";
import { ScaledFrame } from "./ScaledFrame";
import { DEF } from "../reference/params";
import { designSizeFor, type Candidate } from "../models/types";

// Picks the right renderer. HTML candidates render at their native design size inside a
// ScaledFrame (faithful miniature, no reflow squish); glsl candidates fill the container
// (a shader has no fixed layout). `live` gates whether a context actually mounts.
export function CandidateStage({
  cand,
  mode,
  live,
  oneToOne = false,
  onFlag,
}: {
  cand: Candidate;
  mode: 0 | 1 | 2;
  live: boolean;
  oneToOne?: boolean;
  onFlag?: (reason: string) => void;
}) {
  if (cand.kind === "glsl") {
    // a candidate may pin its fixture kind (e.g. a MIDI or drums clip-material seed).
    const fmode = cand.fixtureMode ?? mode;
    return (
      <GlslCandidate frag={cand.source} params={cand.params ?? DEF} mode={fmode} live={live} onFlag={onFlag} />
    );
  }
  const { w, h } = designSizeFor(cand);
  // moshi/stage candidates always get the real creature runtime, whether hand-seeded
  // (usesMoshi flag) or model-generated (the prompt tells them window.Moshi is loaded).
  const usesMoshi =
    cand.usesMoshi || cand.target === "moshi" || cand.target === "stage" || cand.target === "companion";
  const inner = (
    <HtmlCandidate source={cand.source} theme={cand.theme ?? "dark"} live={live} usesMoshi={usesMoshi} />
  );
  // 1:1 (lightbox): render at native size, let the container scroll.
  if (oneToOne) {
    return (
      <div className="oneToOne-wrap">
        <div style={{ width: w, height: h, position: "relative" }}>{inner}</div>
      </div>
    );
  }
  return (
    <ScaledFrame designW={w} designH={h}>
      {inner}
    </ScaledFrame>
  );
}
