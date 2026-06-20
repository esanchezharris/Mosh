import { useState } from "react";
import { useStore } from "../store";

// MP-001 — session entry + roster. Lives in a topbar Pop (the reserved B-5 slot).
// Create a session (share the code) or join one; once connected, shows the peer
// roster + a leave control. All state is fed by the mp_state event (off-snapshot).
export function MultiplayerPanel() {
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const create = useStore((s) => s.mpCreateSession);
  const join = useStore((s) => s.mpJoinSession);
  const leave = useStore((s) => s.mpLeaveSession);

  const [name, setName] = useState("");
  const [color, setColor] = useState("#3aa0ff");
  const [code, setCode] = useState("");

  if (mp.active) {
    return (
      <div className="mp-panel" aria-label="Multiplayer session">
        <div className="mp-head"><strong>Session</strong><span className="mp-dot on" title="connected" /></div>
        <label className="mp-field">Room code
          <input className="mp-code" readOnly value={mp.roomCode ?? ""}
                 onFocus={(e) => e.currentTarget.select()} aria-label="Room code (share to invite)" />
        </label>
        <div className="mp-roster">
          {Object.entries(peers).map(([id, p]) => (
            <div className="mp-peer" key={id}>
              <span className="mp-swatch" style={{ background: p.color }} />
              <span className="mp-peer-name">{p.name}{id === mp.selfPeer ? " (you)" : ""}</span>
              <span className={`mp-dot${p.online ? " on" : ""}`} title={p.online ? "online" : "offline"} />
            </div>
          ))}
        </div>
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
      <button className="btn primary" onClick={() => void create(name, color)}>Create session</button>
      <div className="mp-sep">or join with a code</div>
      <div className="mp-join">
        <input value={code} placeholder="paste room code" onChange={(e) => setCode(e.target.value)}
               aria-label="Room code to join" />
        <button className="btn" disabled={!code.trim()} onClick={() => void join(code.trim(), name, color)}>Join</button>
      </div>
    </div>
  );
}
