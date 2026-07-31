// Agent-change feedback as a self-dismissing TOAST (v2). When Moshi runs a batch of
// edits, the change set surfaces briefly with a one-line summary + an Undo grace
// affordance, then fades on its own (the changes are already applied — auto-dismiss =
// keep). Hovering pauses the timer so Undo stays reachable. This replaces the classic
// MoshiChanges dialog in v2 (the classic shell keeps its manual Keep/Undo panel).

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { undoAgentBatch } from "../agent/executor";

const HOLD_MS = 4500;     // auto-dismiss after this
const RESUME_MS = 2000;   // shorter window after a hover pause
const FADE_MS = 260;

export function ChangeToast() {
  const cs = useStore((s) => s.agentChangeSet);
  const setCs = useStore((s) => s.setAgentChangeSet);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(0);

  const dismiss = () => { setLeaving(true); window.setTimeout(() => setCs(null), FADE_MS); };
  const arm = (ms: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(dismiss, ms); };

  useEffect(() => {
    if (!cs || cs.entries.length === 0) { setLeaving(false); return; }
    setLeaving(false);
    arm(HOLD_MS);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cs]);

  if (!cs || cs.entries.length === 0) return null;
  const head = cs.entries[0]?.summary ?? "Done";
  const more = cs.entries.length - 1;
  const failed = cs.entries.some((e) => !e.ok);
  const undo = async () => { window.clearTimeout(timer.current); await undoAgentBatch(); setCs(null); };

  return (
    <div
      className={`v2-toast${leaving ? " out" : ""}${failed ? " err" : ""}`}
      role="status" aria-live="polite" data-testid="v2-change-toast"
      onMouseEnter={() => window.clearTimeout(timer.current)}
      onMouseLeave={() => arm(RESUME_MS)}
    >
      <span className="v2-toast-dot" aria-hidden>{failed ? "⚠" : "✦"}</span>
      <span className="v2-toast-text">{head}{more > 0 ? ` · +${more} more` : ""}</span>
      <button className="v2-toast-undo" data-testid="v2-toast-undo" onClick={() => void undo()}>Undo</button>
    </div>
  );
}
