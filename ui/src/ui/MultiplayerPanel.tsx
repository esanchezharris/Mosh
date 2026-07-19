import { useState } from "react";
import { useStore } from "../store";
import { loadMpIdentity, saveMpIdentity } from "../multiplayer/identity";
import { ConfirmDialog } from "./ConfirmDialog";

// MP-001 — session entry + roster. Lives in a topbar Pop (the reserved B-5 slot) in
// the classic shell, and in a modal from the v2 shell's prominent Invite affordances
// (MultiplayerLauncher). Create a session (share the code) or join one; once
// connected, shows the peer roster + the room code (always re-visible/copyable, so
// the host can re-share it) + a leave control. All state is fed by the mp_state
// event (off-snapshot).
export function MultiplayerPanel() {
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const create = useStore((s) => s.mpCreateSession);
  const join = useStore((s) => s.mpJoinSession);
  const leave = useStore((s) => s.mpLeaveSession);
  // PR-2 adversarial-review BLOCKER: mp_commit_done had no frontend consumer —
  // surface a stem-upload failure (commit-on-move or a manual commit) here rather
  // than let a track silently stay sourceMissing for the peer with no visible sign.
  const pendingCommits = useStore((s) => s.pendingCommits);
  const failedCommits = useStore((s) => s.failedCommits);
  const retryFailedCommit = useStore((s) => s.retryFailedCommit);
  const tracks = useStore((s) => s.snapshot?.tracks ?? []);
  const trackNameForLogicalId = (lid: string) => tracks.find((t) => t.logicalId === lid)?.name ?? lid;
  const pendingCount = Object.keys(pendingCommits).length;
  const failedEntries = Object.entries(failedCommits);
  // Joining adopts the HOST's project onto this Mac — cmdMpApplyBootstrap drops every
  // local track (non-undoably) before rebuilding from the host's bundle. If this Mac
  // already has real work, gate the join behind a confirm so nobody loses a session by
  // clicking the wrong button. Creating never touches local tracks (only the joiner's
  // side runs the adopt), so it needs no such gate.
  const localTrackCount = useStore((s) => s.snapshot?.tracks.length ?? 0);

  const initialIdentity = loadMpIdentity();
  const [name, setName] = useState(initialIdentity.name);
  const [color, setColor] = useState(initialIdentity.color);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);
  // #42 — inline join feedback. Failures used to land only in the global error bar
  // while the panel the user was looking at stayed silent.
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const persistIdentity = (nextName: string, nextColor: string) => {
    saveMpIdentity({ name: nextName.trim() || "Producer", color: nextColor });
  };

  const doCreate = () => {
    const effectiveName = name.trim() || "Producer";
    persistIdentity(effectiveName, color);
    void create(effectiveName, color);
  };

  const doJoin = (roomCode: string) => {
    const effectiveName = name.trim() || "Producer";
    persistIdentity(effectiveName, color);
    setJoining(true);
    setJoinError(null);
    void join(roomCode, effectiveName, color)
      .then((r) => { if (!r.ok) setJoinError(r.error ?? "join session failed"); })
      .finally(() => setJoining(false));
  };

  const requestJoin = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    if (localTrackCount > 0) { setPendingJoinCode(trimmed); return; }
    doJoin(trimmed);
  };

  const copyCode = async () => {
    const value = mp.roomCode ?? "";
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback for embeds without the async Clipboard API — a hidden textarea + execCommand.
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code is still visible + selectable in the field */
    }
  };

  if (mp.active) {
    return (
      <div className="mp-panel" aria-label="Multiplayer session">
        <div className="mp-head"><strong>Session</strong><span className="mp-dot on" title="connected" /></div>
        <label className="mp-field">Room code
          <div className="mp-code-row">
            <input className="mp-code" readOnly value={mp.roomCode ?? ""}
                   onFocus={(e) => e.currentTarget.select()} aria-label="Room code (share to invite)" />
            <button type="button" className="btn" onClick={() => void copyCode()} disabled={!mp.roomCode}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </label>
        <div className="mp-roster">
          {Object.entries(peers).map(([id, p]) => (
            <div className="mp-peer" key={id}>
              <span className="mp-swatch" style={{ background: p.color }} />
              <span className="mp-peer-name" title={p.name || undefined}>{p.name || "(unnamed)"}{id === mp.selfPeer ? " (you)" : ""}</span>
              <span className={`mp-dot${p.online ? " on" : ""}`} title={p.online ? "online" : "offline"} />
            </div>
          ))}
        </div>
        {pendingCount > 0 && (
          <div className="pop-note" data-testid="mp-commit-pending">
            Syncing {pendingCount} track{pendingCount === 1 ? "" : "s"}…
          </div>
        )}
        {failedEntries.length > 0 && (
          <div className="mp-commit-failed" data-testid="mp-commit-failed">
            {failedEntries.map(([lid, error]) => (
              <div className="mp-commit-failed-row" key={lid} title={error}>
                <span>⚠ {trackNameForLogicalId(lid)} failed to sync</span>
                <button type="button" className="btn" onClick={() => void retryFailedCommit(lid)}>
                  Retry
                </button>
              </div>
            ))}
          </div>
        )}
        <button className="btn" onClick={() => void leave()}>Leave session</button>
      </div>
    );
  }

  return (
    <div className="mp-panel" aria-label="Multiplayer">
      <div className="mp-head"><strong>2-player session</strong></div>
      <label className="mp-field">Your name
        <input value={name} placeholder="You" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mp-field mp-color">Colour
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Your colour" />
      </label>
      <button className="btn primary" onClick={doCreate}>Create session</button>
      <div className="mp-sep">or join with a code</div>
      <div className="mp-join">
        <input value={code} placeholder="paste room code"
               onChange={(e) => { setCode(e.target.value); setJoinError(null); }}
               aria-label="Room code to join" />
        <button className="btn" disabled={!code.trim() || joining} onClick={requestJoin}>
          {joining ? "Joining…" : "Join"}
        </button>
      </div>
      {joinError !== null && (
        <div className="mp-join-error" role="alert" data-testid="mp-join-error">
          ⚠ {joinError}
        </div>
      )}
      {localTrackCount > 0 && (
        <div className="pop-note">
          You have {localTrackCount} track{localTrackCount === 1 ? "" : "s"} in this project — joining a
          session replaces it with the host's, so we'll confirm before that happens.
        </div>
      )}
      {pendingJoinCode !== null && (
        <ConfirmDialog
          title="Join session — replace this project?"
          body={
            <>
              Joining adopts the host's project on this Mac. Your current {localTrackCount} track
              {localTrackCount === 1 ? "" : "s"} will be replaced and this can't be undone.
            </>
          }
          confirmLabel="Join anyway"
          cancelLabel="Cancel"
          danger
          testId="mp-join-confirm"
          onConfirm={() => { const c = pendingJoinCode; setPendingJoinCode(null); doJoin(c); }}
          onCancel={() => setPendingJoinCode(null)}
        />
      )}
    </div>
  );
}
