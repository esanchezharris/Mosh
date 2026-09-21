import { useStore } from "../store";
import type { Snapshot } from "../types";
import { sectionBox, sectionStartSec } from "./timeline";

/** The song's sections (Intro / Verse / Hook …) as a strip over the ruler, on the lane scale.
 *  Read straight from the snapshot the engine and the mock both carry; a click jumps the
 *  transport to the section start. Nothing renders when the session has no sections. */
export function SectionStrip({ sections, tempo, pxPerSec }: {
  sections: Snapshot["sections"]; tempo: number | undefined; pxPerSec: number;
}) {
  const exec = useStore((s) => s.exec);
  if (!sections || sections.length === 0) return null;
  return (
    <div className="sections" data-testid="v3-sections" role="list" aria-label="Sections">
      {sections.map((sec) => {
        const { left, width } = sectionBox(sec, tempo, pxPerSec);
        return (
          <button type="button" key={sec.id} role="listitem" className="section" data-testid="v3-section" data-section-id={sec.id}
            style={{ left, width, ["--sec" as string]: sec.color ?? "var(--accent)" }}
            title={`${sec.name} — jump here`}
            onClick={() => void exec("set_transport", { position: sectionStartSec(sec, tempo) })}>
            <span>{sec.name}</span>
          </button>
        );
      })}
    </div>
  );
}
