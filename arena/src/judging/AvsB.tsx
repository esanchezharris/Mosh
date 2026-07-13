import { useCallback, useEffect, useMemo, useState } from "react";
import { CandidateStage } from "../harness/CandidateStage";
import { arena, computeVisible, useArena } from "../library/store";
import { transport } from "../harness/transport";
import { PASS_LABEL, type Candidate } from "../models/types";

// King-of-the-hill: the champion faces each challenger; you pick a winner (←/→), it
// advances until one look survives the field. Both stages share the transport clock so
// animated looks compare fairly. Space toggles play.
export function AvsB({ onOpen, onToast }: { onOpen: (id: string) => void; onToast: (m: string) => void }) {
  const candidates = useArena((s) => s.candidates);
  const verdicts = useArena((s) => s.verdicts);
  const filter = useArena((s) => s.filter);
  const designer = useArena((s) => s.designer);
  const nonCulled = useMemo(
    () => computeVisible(candidates, verdicts, filter, designer).filter((c) => verdicts[c.id] !== "culled"),
    [candidates, verdicts, filter, designer],
  );
  const key = nonCulled.map((c) => c.id).join(",");

  const [champ, setChamp] = useState<Candidate | null>(null);
  const [idx, setIdx] = useState(1);

  // reset the bracket whenever the field changes
  useEffect(() => {
    setChamp(nonCulled[0] ?? null);
    setIdx(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const challenger = nonCulled[idx] ?? null;
  const done = champ && idx >= nonCulled.length;

  const pick = useCallback(
    (winner: Candidate) => {
      if (!champ || !challenger) return;
      if (winner.id === challenger.id) setChamp(challenger);
      setIdx((i) => i + 1);
    },
    [champ, challenger],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") { e.preventDefault(); transport.toggle(); return; }
      if (!champ || !challenger) return;
      if (e.key === "ArrowLeft") pick(champ);
      if (e.key === "ArrowRight") pick(challenger);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [champ, challenger, pick]);

  const mode = useArena((s) => s.mode);

  if (nonCulled.length < 2) return <div className="empty">need at least two candidates to compare<br />generate or widen the filter</div>;

  if (done && champ) {
    return (
      <div className="avb">
        <div className="avb-pair" style={{ gridTemplateColumns: "1fr" }}>
          <div className="avb-side">
            <div className="avb-stage win">
              <CandidateStage cand={champ} mode={mode} live onFlag={(r) => arena.flag(champ.id, r)} />
            </div>
            <div className="avb-cap"><span>👑 winner · {champ.title} — {champ.model}</span></div>
          </div>
        </div>
        <div className="avb-foot">
          <button className="btn primary" onClick={() => { arena.saveToLibrary(champ); onToast(`saved winner "${champ.title}"`); }}>★ save winner to library</button>
          <button className="btn" onClick={() => { setChamp(nonCulled[0] ?? null); setIdx(1); }}>⟲ run again</button>
        </div>
      </div>
    );
  }

  if (!champ || !challenger) return <div className="empty">…</div>;

  return (
    <div className="avb">
      <div className="avb-pair">
        <Side cand={champ} tag="← keep champion" onPick={() => pick(champ)} mode={mode} onOpen={onOpen} />
        <Side cand={challenger} tag="pick challenger →" onPick={() => pick(challenger)} mode={mode} onOpen={onOpen} />
      </div>
      <div className="avb-foot">
        <span className="avb-key">← / → pick · space play/pause · {idx} of {nonCulled.length}</span>
      </div>
    </div>
  );
}

function Side({ cand, tag, onPick, mode, onOpen }: { cand: Candidate; tag: string; onPick: () => void; mode: 0 | 1 | 2; onOpen: (id: string) => void }) {
  return (
    <div className="avb-side">
      <div className="avb-stage" onClick={onPick} role="button" tabIndex={0}>
        <CandidateStage cand={cand} mode={mode} live onFlag={(r) => arena.flag(cand.id, r)} />
        <button className="cand-zoom" onClick={(e) => { e.stopPropagation(); onOpen(cand.id); }} title="maximize">⤢</button>
      </div>
      <div className="avb-cap">
        <span>{cand.title} · <b style={{ color: cand.pass === "bolder" ? "#ff8a3d" : "var(--a-lime)" }}>{PASS_LABEL[cand.pass]}</b> · {cand.model}</span>
        <span>{tag}</span>
      </div>
    </div>
  );
}
