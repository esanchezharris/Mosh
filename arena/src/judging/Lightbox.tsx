import { useCallback, useEffect, useState } from "react";
import { CandidateStage } from "../harness/CandidateStage";
import { transport } from "../harness/transport";
import { arena, useArena } from "../library/store";
import { MODE_NAMES } from "../kit/fixtures";
import { PASS_LABEL, type Candidate } from "../models/types";
import type { Theme } from "../kit/tokens";

// Maximize: fills the viewport so a candidate is fully readable + interactive. ←/→ walk
// the filtered field, esc closes, space plays. Fit⟷1:1, fixture (audio/midi/drums), and
// theme toggles let you assess a look across material and both themes.
export function Lightbox({
  list,
  index,
  setIndex,
  onClose,
  onTune,
  onToast,
  initialMode,
}: {
  list: Candidate[];
  index: number;
  setIndex: (i: number) => void;
  onClose: () => void;
  onTune: (c: Candidate) => void;
  onToast: (m: string) => void;
  initialMode: 0 | 1 | 2;
}) {
  const cand = list[index];
  const [mode, setMode] = useState<0 | 1 | 2>(initialMode);
  const [theme, setTheme] = useState<Theme>(cand?.theme ?? "dark");
  const [oneToOne, setOneToOne] = useState(false);

  const verdict = useArena((s) => (cand ? s.verdicts[cand.id] : undefined));
  const inLib = useArena((s) => (cand ? s.library.some((x) => x.id === cand.id) : false));

  const n = list.length;
  const go = useCallback((d: number) => setIndex((index + d + n) % n), [index, n, setIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.code === "Space") { e.preventDefault(); transport.toggle(); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go, onClose]);

  if (!cand) return null;
  const staged: Candidate = theme === cand.theme ? cand : { ...cand, theme };

  return (
    <div className="lb-scrim" role="dialog" aria-modal="true">
      <div className="lb-head">
        <div className={`lb-badge${cand.pass === "bolder" ? " bolder" : ""}`}>{PASS_LABEL[cand.pass]}</div>
        <div className="lb-title">
          <b>{cand.title}</b>
          <span>{cand.target} · {cand.model}{cand.notes ? ` · ${cand.notes}` : ""}</span>
        </div>
        <div className="arena-spacer" />
        <span className="lb-key">← → browse · esc close · space play</span>
        <button className="btn ghost" onClick={onClose} aria-label="close">✕</button>
      </div>

      <div className="lb-stage-wrap">
        {n > 1 && <button className="lb-nav prev" onClick={() => go(-1)} aria-label="previous">‹</button>}
        <div className="lb-stage">
          <CandidateStage cand={staged} mode={mode} live oneToOne={oneToOne} onFlag={(r) => arena.flag(cand.id, r)} />
        </div>
        {n > 1 && <button className="lb-nav next" onClick={() => go(1)} aria-label="next">›</button>}
      </div>

      <div className="lb-foot">
        <button className={`btn${verdict === "promoted" ? " primary" : ""}`} onClick={() => arena.setVerdict(cand.id, verdict === "promoted" ? undefined : "promoted")}>↑ keep</button>
        <button className="btn ghost" onClick={() => arena.setVerdict(cand.id, verdict === "culled" ? undefined : "culled")}>✕ cull</button>
        <button className="btn ghost" disabled={inLib} onClick={() => { arena.saveToLibrary(cand); onToast(`saved "${cand.title}"`); }}>{inLib ? "★ saved" : "☆ save"}</button>
        {cand.kind === "glsl" && <button className="btn ghost" onClick={() => onTune(cand)}>◐ tune</button>}

        <div className="arena-spacer" />

        {cand.kind === "glsl" && (
          <div className="seg" aria-label="fixture">
            {MODE_NAMES.map((m, i) => (
              <button key={m} className={mode === i ? "on" : ""} onClick={() => setMode(i as 0 | 1 | 2)}>{m}</button>
            ))}
          </div>
        )}
        {cand.kind === "html" && (
          <div className="seg" aria-label="theme">
            <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}>dark</button>
            <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>cream</button>
          </div>
        )}
        <div className="seg" aria-label="scale">
          <button className={!oneToOne ? "on" : ""} onClick={() => setOneToOne(false)}>fit</button>
          <button className={oneToOne ? "on" : ""} onClick={() => setOneToOne(true)}>1:1</button>
        </div>
      </div>
    </div>
  );
}
