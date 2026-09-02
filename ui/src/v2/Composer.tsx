// The "Ask Mosh" composer bar. Wraps the existing AgentComposer (voice + text → the
// agent pipeline) so voice, deterministic fast paths, and bounded studio skills are
// shared across shells. The
// left "+" is the existing FileOptions control (File / Open / Save / Recent / Settings
// / Export / Samples via the shared runAction dispatcher) — demo-faithful and gives v2
// every app/file surface for free. Reference/hum affordances ride inside AgentComposer.

import { useStore } from "../store";
import { AgentComposer } from "../ui/AgentComposer";
import { FileOptions } from "../ui/FileOptions";
import { MoshMark } from "./MoshMark";
import { AgentDrawer } from "./agent/AgentDrawer";
import { useTaskStore } from "../agent/loop/taskStore";

export function Composer() {
  const snapshot = useStore((s) => s.snapshot);
  const hasTask = useTaskStore((s) => s.current !== null || s.last !== null);
  const drawerOpen = useTaskStore((s) => s.drawerOpen);
  const setDrawerOpen = useTaskStore((s) => s.setDrawerOpen);
  // A narrow, centered prompt bar. The bar carries a small STATIC Moshi face as the send
  // cue (personality without a second WebGL canvas) — the live, "maximized" Moshi lives in
  // the always-on right rail, which is his only animated mount.
  // The agent drawer docks directly ABOVE the bar (progressive disclosure —
  // visible only while a task runs or right after; never a fourth gutter).
  return (
    <div className="v2-composer-stack">
      <AgentDrawer />
      <div className="v2-composer" data-testid="v2-composer">
        <div className="v2-composer-side">
          {/* The face doubles as the drawer recall once a task exists — the
              progressive-disclosure re-entry point after auto-collapse. */}
          {hasTask ? (
            <button
              className="v2-composer-face-btn" data-testid="agent-drawer-toggle"
              title={drawerOpen ? "Hide Moshi's last task" : "Show Moshi's last task"}
              aria-label={drawerOpen ? "Hide Moshi's last task" : "Show Moshi's last task"}
              onClick={() => setDrawerOpen(!drawerOpen)}
            >
              <MoshMark size={26} className="v2-composer-face" />
            </button>
          ) : (
            <MoshMark size={26} className="v2-composer-face" />
          )}
          {snapshot && <div className="v2-composer-plus"><FileOptions snapshot={snapshot} /></div>}
        </div>
        <div className="v2-composer-host">
          <div className="v2-composer-copy" aria-hidden="true">
            <span className="v2-composer-kicker">Ask Moshi</span>
            <span className="v2-composer-hint">Type arrangement moves, take decisions, and quick fixes.</span>
          </div>
          <AgentComposer />
        </div>
      </div>
    </div>
  );
}
