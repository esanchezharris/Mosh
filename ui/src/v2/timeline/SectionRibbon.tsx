// The song-structure ribbon (INTRO / VERSE / HOOK / …). Reads snapshot.sections,
// positions each segment on the shared seconds x-axis, and seeks on click. Editing
// (create/move/rename/remove_section) comes in a later slice; this is the read +
// seek surface. Width matches the lanes so segments line up with the bar ruler.

import { useStore } from "../../store";
import type { Snapshot } from "../../types";
import { beatToSec } from "./geom";

const SEG_COLORS = ["#7d8cff", "#9b8cff", "#6fa8ff", "#8c7dff", "#6fb6ff"];

export function SectionRibbon({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const sections = snapshot.sections ?? [];

  return (
    <div className="v2-ribbon" style={{ width }} data-testid="v2-section-ribbon">
      {sections.map((sec, i) => {
        const startSec = beatToSec(snapshot, sec.startBeat);
        const endSec = beatToSec(snapshot, sec.endBeat);
        const left = startSec * pxPerSec;
        const w = Math.max(0, (endSec - startSec) * pxPerSec);
        const color = sec.color ?? SEG_COLORS[i % SEG_COLORS.length];
        return (
          <div
            key={sec.id}
            className="v2-seg"
            style={{ left, width: w }}
            title={`${sec.name} — click to jump`}
            data-testid="v2-section"
            onClick={() => void exec("set_transport", { position: startSec })}
          >
            <span>{sec.name}</span>
            <span className="v2-seg-bar" style={{ background: color }} />
          </div>
        );
      })}
    </div>
  );
}
