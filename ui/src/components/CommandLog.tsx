import { useState } from "react";
import { useStore } from "../store";
import type { CommandLog as CommandLogData } from "../types";

// Command-log inspector (AGT-001) — a READ-ONLY window over the product's canonical
// command contract: every state change is a logged MoshOps command (mosh-log.jsonl).
// This panel makes that log visible. It never mutates: it only reads it back via the
// read-only get_command_log command (modeled on Settings/RemoteCompanion popovers;
// reuses .remote-pop / .tool-btn — no new visual language). Lazy-loads on open,
// mirroring loadColors/loadAudioDevices.
const LIMIT = 50;

function shortTime(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function CommandLog() {
  const exec = useStore((s) => s.exec);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<CommandLogData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    // Read-only command — never mutates; never appears in its own results.
    const res = await exec("get_command_log", { limit: LIMIT });
    if (res.ok && res.data) setLog(res.data as CommandLogData);
    setLoading(false);
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load(); // lazy-load on open (mirrors openBrowser/loadColors)
  };

  const entries = log?.entries ?? [];

  return (
    <div className="remote-companion">
      <button
        className={`tool-btn ${open ? "on" : ""}`}
        onClick={toggle}
        title="Command log — recent MoshOps commands"
      >
        ☰
      </button>
      {open && (
        <div className="remote-pop cmdlog-pop">
          <div className="remote-head">
            <strong>Command log</strong>
            <span className="cmdlog-actions">
              <button className="mini" onClick={() => void load()} title="Refresh">↻</button>
              <button className="mini" onClick={() => setOpen(false)}>x</button>
            </span>
          </div>

          <div className="cmdlog-meta">
            {loading ? "Loading…" : `${entries.length} of ${log?.total ?? 0} commands · most recent first`}
          </div>

          <div className="cmdlog-list">
            {entries.length === 0 && !loading ? (
              <div className="cmdlog-empty">No commands logged yet.</div>
            ) : (
              entries.map((e, i) => (
                <div className={`cmdlog-row ${e.ok ? "ok" : "err"}`} key={`${e.seq ?? i}-${i}`}>
                  <span className={`cmdlog-dot ${e.ok ? "ok" : "err"}`} title={e.ok ? "ok" : "error"}>
                    {e.ok ? "●" : "✕"}
                  </span>
                  <span className="cmdlog-name" title={e.error ?? e.command}>{e.command}</span>
                  {e.undoable && <span className="cmdlog-badge" title="undoable">undo</span>}
                  <span className="cmdlog-ts">{shortTime(e.ts)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
