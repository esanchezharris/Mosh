import { useEffect, useState } from "react";
import { useStore } from "../store";
import { historyRowHint, historyRows } from "../ui/commandLogHistory";
import type { CommandLog } from "../types";
import { useV3 } from "./shellState";

export function HistoryFlyout() {
  const open = useV3((s) => s.historyOpen);
  const setOpen = useV3((s) => s.setHistoryOpen);
  const exec = useStore((s) => s.exec);
  const [log, setLog] = useState<CommandLog | null>(null);

  const load = async () => {
    const r = await exec("get_command_log", { limit: 50 });
    if (r.ok && r.data) setLog(r.data as CommandLog);
  };

  useEffect(() => { if (open) void load(); }, [open]);

  if (!open) return null;
  const rows = historyRows(log);

  return (
    <div className="hist-flyout open" role="dialog" aria-label="History" data-testid="v3-history-flyout">
      <div className="pane-hd">
        <span className="sec">History</span>
        <span className="muted" style={{ fontSize: 10, color: "var(--fog-label)" }}>Cmd+Z · click older</span>
        <button type="button" className="icon-x" aria-label="Close" onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="hist-list">
        {rows.length === 0 ? <div className="set-hint">no commands yet</div> : rows.map((row, i) => {
          const e = row.entry;
          const when = new Date(e.ts ?? 0).toISOString().slice(14, 19);
          const canJump = !!row.txn && !row.isCurrent;
          return (
            <div key={i} className={`hist-row${row.isCurrent ? " prog" : ""}`} title={historyRowHint(row)}>
              <span className="when">{when}</span>
              <span className={`dot${row.isCurrent ? " prog" : ""}`} />
              <span className="flex">{e.command}</span>
              {canJump && (
                <button type="button" className="btn ghost sm" data-testid="v3-history-undo"
                  onClick={() => void exec("jump_to_history", { txn: row.txn }).then(() => load())}>
                  Undo
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
