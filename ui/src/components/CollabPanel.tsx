import { useState } from "react";
import { useStore } from "../store";

type CollabStatus = {
  ahead: number;
  behind: number;
  pendingLocal: number;
  state_hash: string;
};
type Conflict = { command: string; error: string };

/** Git-style ASYNC session sync ("like GitHub", not real-time). Share or join
 *  a session by remote URL; pull replays collaborators' ops through the same
 *  engine and verifies convergence with the canonical state hash; a behind
 *  push is rejected — pull first (rebase happens automatically, conflicts are
 *  listed, never silent). Pure UI over collab_* commands. */
export function CollabPanel() {
  const exec = useStore((s) => s.exec);
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState("");
  const [status, setStatus] = useState<CollabStatus | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const r = await exec("collab_status", {});
    if (r.ok && r.data) setStatus(r.data as CollabStatus);
    return r.ok;
  };

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const share = () =>
    act(async () => {
      const r = await exec("collab_init", remote.trim() ? { remote: remote.trim() } : {});
      return r.ok ? "session shared" : null;
    });

  const join = () =>
    act(async () => {
      if (!remote.trim()) return "enter a remote URL to join";
      const r = await exec("collab_clone", { remote: remote.trim() });
      if (r.ok && r.data) {
        const d = r.data as { applied: number; conflicts: Conflict[] };
        setConflicts(d.conflicts ?? []);
        return `joined: ${d.applied} ops replayed`;
      }
      return null;
    });

  const pull = () =>
    act(async () => {
      const r = await exec("collab_pull", {});
      if (r.ok && r.data) {
        const d = r.data as { applied: number; conflicts: Conflict[] };
        setConflicts(d.conflicts ?? []);
        return d.conflicts?.length
          ? `pulled with ${d.conflicts.length} conflict(s) — see list`
          : `pulled: ${d.applied} ops applied`;
      }
      return null;
    });

  const push = () =>
    act(async () => {
      const r = await exec("collab_push", {});
      return r.ok ? `pushed ${(r.data as { pushed: number })?.pushed ?? 0} step(s)` : null;
    });

  if (!open) {
    return (
      <button
        className="tool-btn"
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
        title="Collab: share or join a session (git-style, async)"
      >
        ⇅ Sync
      </button>
    );
  }

  return (
    <div className="collab-panel">
      {status === null ? (
        <>
          <input
            className="tutorial-input collab-remote"
            placeholder="remote URL (git)"
            value={remote}
            onChange={(e) => setRemote(e.target.value)}
          />
          <button className="tool-btn" disabled={busy} onClick={() => void share()}
                  title="Share THIS session at the remote">
            Share
          </button>
          <button className="tool-btn" disabled={busy} onClick={() => void join()}
                  title="Join an existing shared session (replaces this session)">
            Join
          </button>
        </>
      ) : (
        <>
          <span className="collab-status" title={`state ${status.state_hash.slice(0, 12)}…`}>
            ↑{status.ahead + status.pendingLocal} ↓{status.behind}
          </span>
          <button className="tool-btn" disabled={busy} onClick={() => void pull()}>Pull</button>
          <button className="tool-btn" disabled={busy} onClick={() => void push()}>Push</button>
        </>
      )}
      {msg && <span className="tutorial-status">{msg}</span>}
      {conflicts.length > 0 && (
        <span className="collab-conflicts" title={conflicts.map((c) => `${c.command}: ${c.error}`).join("\n")}>
          ⚠ {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}
        </span>
      )}
      <button className="tool-btn" onClick={() => setOpen(false)} title="Collapse">×</button>
    </div>
  );
}
