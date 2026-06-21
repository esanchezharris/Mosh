// Section navigator (redesign shell): a song-structure minimap of named sections
// (Intro/Verse/Hook/…). Click a section to jump the playhead there; double-click to
// rename; + Section adds one; 8B/16b/Full set the timeline zoom. Sections are real
// project data (mock-backed for now); later they become agent scope handles. All
// mutation is via the command seam (create/rename/remove_section); zoom is UI-local.
import { useStore } from "../store";
import type { Snapshot, Section } from "../types";

export function SectionNavigator({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);
  const sections = snapshot.sections ?? [];
  const tempo = snapshot.session.tempo || 120;
  const beatSec = 60 / tempo;
  const sigNum = snapshot.session.timeSigNumerator ?? 4;
  const spanBeats = Math.max(16, ...sections.map((s) => s.endBeat));

  const jump = (sec: Section) => void exec("set_transport", { action: "seek", position: sec.startBeat * beatSec });
  const rename = (sec: Section) => {
    const n = window.prompt("Section name:", sec.name);
    if (n != null && n.trim()) void exec("rename_section", { sectionId: sec.id, name: n.trim() });
  };
  const remove = (sec: Section) => void exec("remove_section", { sectionId: sec.id });
  const addSection = () => {
    const start = sections.length ? Math.max(...sections.map((s) => s.endBeat)) : 0;
    void exec("create_section", { name: "Section", startBeat: start, endBeat: start + 16 });
  };
  const fitBars = (bars: number) => {
    const secs = Math.max(1, bars * sigNum * beatSec);
    setPxPerSec(Math.max(20, Math.min(400, Math.round(900 / secs))));
  };

  return (
    <div className="section-nav" data-testid="section-nav">
      <div className="section-track">
        {sections.length === 0 && <span className="section-empty">No sections yet — add one to map the song</span>}
        {sections.map((sec) => (
          <div key={sec.id} className="section-seg" data-testid="section-seg"
            style={{ left: `${(sec.startBeat / spanBeats) * 100}%`, width: `${((sec.endBeat - sec.startBeat) / spanBeats) * 100}%`, background: sec.color ?? "var(--lime-dim)" }}>
            <button className="section-jump" title={`${sec.name} — click to jump · double-click to rename`}
              onClick={() => jump(sec)} onDoubleClick={() => rename(sec)}>
              <span className="section-label">{sec.name}</span>
            </button>
            <button className="section-x" title="Remove section" aria-label={`Remove ${sec.name}`} onClick={() => remove(sec)}>✕</button>
          </div>
        ))}
      </div>
      <button className="btn section-add" data-testid="section-add" onClick={addSection}>+ Section</button>
      <div className="seg section-zoom" role="group" aria-label="Zoom to bars">
        <button className="btn" onClick={() => fitBars(8)}>8B</button>
        <button className="btn" onClick={() => fitBars(16)}>16b</button>
        <button className="btn" onClick={() => fitBars(Math.max(8, Math.ceil(spanBeats / sigNum)))}>Full</button>
      </div>
    </div>
  );
}
