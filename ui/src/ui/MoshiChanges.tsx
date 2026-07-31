// Moshi changes — the review surface for a batch of agent edits. One ask becomes
// one undo step; this lists what Moshi did in plain English with Keep / Undo.
// Renders as a panel above the dock when there's an active change set.

import { useStore } from "../store";
import { undoAgentBatch } from "../agent/executor";

export function MoshiChanges() {
  const cs = useStore((s) => s.agentChangeSet);
  const setAgentChangeSet = useStore((s) => s.setAgentChangeSet);
  if (!cs || cs.entries.length === 0) return null;

  const keep = () => setAgentChangeSet(null);
  const undo = async () => { await undoAgentBatch(); setAgentChangeSet(null); };

  return (
    <div className="moshi-changes" role="dialog" aria-label="Moshi changes" data-testid="moshi-changes">
      <div className="moshi-changes-head">
        <span className="moshi-changes-title">Moshi changes</span>
        <button className="btn x" aria-label="Dismiss" onClick={keep}>✕</button>
      </div>
      <div className="moshi-changes-list">
        {cs.entries.map((e, i) => (
          <div key={i} className={`moshi-changes-row${e.ok ? "" : " err"}`}>
            <span className="moshi-changes-dot" aria-hidden="true">{e.ok ? "✓" : "✕"}</span>
            <span className="moshi-changes-text" title={e.error}>{e.summary}{e.error ? ` — ${e.error}` : ""}</span>
          </div>
        ))}
      </div>
      <div className="moshi-changes-actions">
        <button className="btn" data-testid="moshi-changes-undo" onClick={() => void undo()}>Undo</button>
        <button className="btn on" data-testid="moshi-changes-keep" onClick={keep}>Keep</button>
      </div>
    </div>
  );
}
