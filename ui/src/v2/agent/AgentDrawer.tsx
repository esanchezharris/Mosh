// The agent drawer — the progressive-disclosure surface for multi-step tasks.
// Docked ABOVE the composer (no fourth gutter: the push-dock frame is the
// shell's doctrine). Ambient Moshi (caption + creature) stays the default; this
// drawer auto-opens while a task runs, shows the plan + one chip per step, and
// auto-collapses a beat after a clean finish (errors and questions stay up).
// Footer: Stop while running · Undo task after it lands.

import { useEffect, useRef } from "react";
import { useTaskStore } from "../../agent/loop/taskStore";
import { undoAgentTask } from "../../agent/loop/runTask";
import { StepChip } from "./StepChip";
import type { TaskView } from "../../agent/loop/taskStore";

const OUTCOME_COPY: Record<string, string> = {
  done: "done",
  need_user: "needs you",
  budget: "paused — out of budget",
  error: "hit a wall",
  aborted: "stopped",
};

function TurnBody({ task, live }: { task: TaskView; live: boolean }) {
  const nextGoal = task.plan[task.steps.filter((s) => !s.running).length]?.goal;
  return (
    <>
      <div className="v2-agent-turn-ask">“{task.ask}”</div>
      {task.plan.length > 0 && (
        <div className="v2-agent-plan" data-testid="agent-plan">
          {task.plan.map((p, i) => {
            const done = i < task.steps.filter((s) => !s.running && s.results.every((r) => r.ok)).length;
            return <span key={i} className={`v2-agent-plan-step${done ? " done" : ""}`}>{i + 1}. {p.goal}</span>;
          })}
        </div>
      )}
      <div className="v2-agent-chips">
        {task.steps.map((s, i) => <StepChip key={i} step={s} index={i} />)}
        {live && task.phase === "planning" && <div className="v2-agent-chip running"><span className="v2-agent-spin" /> <span className="v2-agent-chip-text">thinking it through…</span></div>}
        {live && task.phase === "repairing" && <div className="v2-agent-chip running"><span className="v2-agent-spin" /> <span className="v2-agent-chip-text">fixing {nextGoal ? `“${nextGoal}”` : "that"}…</span></div>}
      </div>
      {task.say && <div className="v2-agent-say">{task.say}</div>}
    </>
  );
}

export function AgentDrawer() {
  const current = useTaskStore((s) => s.current);
  const last = useTaskStore((s) => s.last);
  const open = useTaskStore((s) => s.drawerOpen);
  const setOpen = useTaskStore((s) => s.setDrawerOpen);
  const requestStop = useTaskStore((s) => s.requestStop);

  // Auto-collapse a beat after a CLEAN finish; anything needing eyes stays up.
  const collapseTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (current || !last) return;
    if (last.outcome === "done" || last.outcome === "aborted") {
      collapseTimer.current = window.setTimeout(() => setOpen(false), 2600);
      return () => { if (collapseTimer.current !== undefined) clearTimeout(collapseTimer.current); };
    }
    return undefined;
  }, [current, last, setOpen]);

  const task = current ?? last;
  if (!open || !task) return null;
  const live = current !== null;

  return (
    <div className={`v2-agent-drawer${live ? " live" : ""}`} data-testid="agent-drawer" role="log" aria-label="Moshi's task">
      <div className="v2-agent-head">
        <span className="v2-agent-head-title">
          {live ? (task.phase === "planning" ? "Moshi is planning…" : "Moshi is working…")
                : `Moshi ${OUTCOME_COPY[task.outcome ?? "done"] ?? "finished"}`}
        </span>
        <span className="v2-agent-head-actions">
          {live
            ? <button className="v2-agent-btn stop" data-testid="agent-stop" onClick={requestStop}>Stop</button>
            : (
              <>
                {(task.outcome === "done" || task.outcome === "aborted") && task.steps.length > 0 && (
                  <button className="v2-agent-btn" data-testid="agent-undo-task" onClick={() => void undoAgentTask()}>Undo task</button>
                )}
                <button className="v2-agent-btn" data-testid="agent-drawer-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
              </>
            )}
        </span>
      </div>
      <TurnBody task={task} live={live} />
    </div>
  );
}
