import { useState } from "react";
import { GlslCandidate } from "../harness/GlslCandidate";
import { CONTROLS, SWATCHES, type Params } from "../reference/params";
import { arena, useArena } from "../library/store";
import { uid, type Candidate } from "../models/types";

// Hand-adjust a waveform candidate's params live (the v3-style lab), then fork it back
// onto the wall as a new candidate. Params update live without recompiling the shader.
export function Tuner({ cand, onClose, onToast }: { cand: Candidate; onClose: () => void; onToast: (m: string) => void }) {
  const mode = useArena((s) => s.mode);
  const [p, setP] = useState<Params>({ ...(cand.params ?? {}) });
  const setKey = (k: string, v: number | string) => setP((prev) => ({ ...prev, [k]: v }));

  const fork = () => {
    const c: Candidate = {
      ...cand,
      id: uid("tuned"),
      title: `${cand.title} · tuned`,
      model: "tuned",
      params: { ...p },
      createdAt: Date.now(),
      flag: undefined,
    };
    arena.addCandidates([c]);
    onToast(`forked "${c.title}" onto the wall`);
    onClose();
  };

  return (
    <div className="tuner-scrim" onClick={onClose}>
      <div className="tuner" onClick={(e) => e.stopPropagation()}>
        <div className="tuner-view">
          <GlslCandidate frag={cand.source} params={p} mode={mode} live />
        </div>
        <div className="tuner-panel">
          <div className="tuner-head">
            <b>{cand.title}</b>
            <button className="btn ghost" onClick={onClose}>✕</button>
          </div>
          <div className="tuner-swatches">
            {SWATCHES.map(([k, lab]) => (
              <label className="sw" key={k}>
                <input type="color" value={String(p[k] ?? "#000000")} onChange={(e) => setKey(k, e.target.value)} />
                <span>{lab}</span>
              </label>
            ))}
          </div>
          <div className="tuner-ctls">
            {CONTROLS.filter((c) => c.type === "range").map((c) => (
              <div className="ctl" key={c.key}>
                <div className="lab"><span>{c.label}</span><output>{Number(p[c.key] ?? 0).toFixed(2)}</output></div>
                <input type="range" min={c.min} max={c.max} step={c.step} value={Number(p[c.key] ?? 0)} onChange={(e) => setKey(c.key, +e.target.value)} />
              </div>
            ))}
          </div>
          <div className="tuner-foot">
            <button className="btn primary" onClick={fork}>＋ fork onto wall</button>
            <button className="btn" onClick={() => { arena.saveToLibrary({ ...cand, params: { ...p } }); onToast("saved to library"); }}>★ save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
