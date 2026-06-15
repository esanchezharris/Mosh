// Monster changes — the review surface for a batch of agent edits. One ask becomes
// one undo step; this lists what Moshi did in plain English with Keep / Undo.
// Renders as a panel above the dock when there's an active change set.

import { useStore } from "../store";
import { undoAgentBatch } from "../agent/executor";

export function MonsterChanges() {
  const cs = useStore((s) => s.agentChangeSet);
  const setAgentChangeSet = useStore((s) => s.setAgentChangeSet);
  if (!cs || cs.entries.length === 0) return null;

  const keep = () => setAgentChangeSet(null);
  const undo = async () => { await undoAgentBatch(); setAgentChangeSet(null); };

  return (
    <div className="monster" role="dialog" aria-label="Monster changes" data-testid="monster-changes">
      <div className="monster-head">
        <span className="monster-title">Monster changes</span>
        <button className="btn x" aria-label="Dismiss" onClick={keep}>✕</button>
      </div>
      <div className="monster-list">
        {cs.entries.map((e, i) => (
          <div key={i} className={`monster-row${e.ok ? "" : " err"}`}>
            <span className="monster-dot" aria-hidden="true">{e.ok ? "✓" : "✕"}</span>
            <span className="monster-text" title={e.error}>{e.summary}{e.error ? ` — ${e.error}` : ""}</span>
          </div>
        ))}
      </div>
      <div className="monster-actions">
        <button className="btn" data-testid="monster-undo" onClick={() => void undo()}>Undo</button>
        <button className="btn on" data-testid="monster-keep" onClick={keep}>Keep</button>
      </div>
    </div>
  );
}
