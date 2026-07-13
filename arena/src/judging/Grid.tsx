import { useCallback } from "react";
import { CandidateStage } from "../harness/CandidateStage";
import { useOnScreen } from "../harness/useOnScreen";
import { arena, useArena, type Verdict } from "../library/store";
import { PASS_LABEL, type Candidate } from "../models/types";

// The wall / hot-or-not. Live-renders only on-screen tiles; click a tile (or ⤢) to
// MAXIMIZE it; promote (↑), cull (✕), save, and tune (glsl). Culled tiles fade + sort back.
export function Grid({
  list,
  mode,
  onOpen,
  onTune,
  onToast,
}: {
  list: Candidate[];
  mode: 0 | 1 | 2;
  onOpen: (id: string) => void;
  onTune: (c: Candidate) => void;
  onToast: (m: string) => void;
}) {
  if (list.length === 0) return <div className="empty">no candidates for this filter yet</div>;
  return (
    <div className="wall">
      <div className="wall-grid">
        {list.map((c) => (
          <Card key={c.id} cand={c} mode={mode} onOpen={onOpen} onTune={onTune} onToast={onToast} />
        ))}
      </div>
    </div>
  );
}

function Card({
  cand,
  mode,
  onOpen,
  onTune,
  onToast,
}: {
  cand: Candidate;
  mode: 0 | 1 | 2;
  onOpen: (id: string) => void;
  onTune: (c: Candidate) => void;
  onToast: (m: string) => void;
}) {
  const [ref, visible] = useOnScreen<HTMLDivElement>();
  const verdict = useArena((s) => s.verdicts[cand.id]);
  const inLib = useArena((s) => s.library.some((x) => x.id === cand.id));

  const vote = useCallback(
    (v: Verdict) => arena.setVerdict(cand.id, verdict === v ? undefined : v),
    [cand.id, verdict],
  );
  const onFlag = useCallback((reason: string) => arena.flag(cand.id, reason), [cand.id]);

  return (
    <div ref={ref} className={`cand${verdict === "promoted" ? " promoted" : ""}${verdict === "culled" ? " culled" : ""}`}>
      <div className="cand-stage" onClick={() => onOpen(cand.id)} title="click to maximize">
        <div className={`cand-badge${cand.pass === "bolder" ? " bolder" : ""}`}>
          <span className="pass">{PASS_LABEL[cand.pass]}</span>
          <span>{cand.target}</span>
        </div>
        {cand.flag && <div className="cand-flag" title={cand.flag}>⚠ {cand.flag.split("(")[0].trim()}</div>}
        <CandidateStage cand={cand} mode={mode} live={visible} onFlag={onFlag} />
        <button className="cand-zoom" onClick={(e) => { e.stopPropagation(); onOpen(cand.id); }} title="maximize">⤢</button>
      </div>
      <div className="cand-meta">
        <div className="cand-title">{cand.title}</div>
        <div className="cand-sub">{cand.model} · {cand.kind}</div>
      </div>
      <div className="cand-actions">
        <button className={`btn${verdict === "promoted" ? " primary" : ""}`} onClick={() => vote("promoted")} title="promote">↑ keep</button>
        <button className="btn ghost" onClick={() => vote("culled")} title="cull">✕</button>
        {cand.kind === "glsl" && <button className="btn ghost" onClick={() => onTune(cand)} title="tune params">◐</button>}
        <button className="btn ghost" disabled={inLib} onClick={() => { arena.saveToLibrary(cand); onToast(`saved "${cand.title}"`); }} title="save to library">{inLib ? "★" : "☆"}</button>
      </div>
    </div>
  );
}
