// The right rail: the MOSH card (the live 3D character + a status line) and the
// COLLABORATORS card (peers + invite). Moshi is reused verbatim — he self-wires from
// the store, so the card just frames him. The status line narrates the agent's last
// move (agentUtter.say) with a transport/render fallback ladder. Video tiles land in
// the collaborators slice; this is presence + invite.

import { useEffect } from "react";
import { useStore } from "../store";
import { Moshi } from "../ui/Moshi";
import { useVideo } from "../webrtc/useVideo";
import { VideoTile } from "../ui/VideoTile";
import { Inspector } from "./inspector/Inspector";

export function RightRail() {
  return (
    <aside className="v2-rail" data-testid="v2-rail">
      <MoshCard />
      <Inspector />
      <CollaboratorsCard />
    </aside>
  );
}

function MoshCard() {
  return (
    <section className="v2-card v2-mosh-card" data-testid="v2-mosh-card">
      <div className="v2-card-head">
        <span>Mosh</span>
        <span className="v2-live"><span className="led" /> Live</span>
      </div>
      <div className="v2-mosh-stage"><Moshi /></div>
      <MoshStatusLine />
    </section>
  );
}

function MoshStatusLine() {
  const say = useStore((s) => s.agentUtter?.say);
  const recording = useStore((s) => s.transport.recording);
  const playing = useStore((s) => s.transport.playing);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const text = say || (recording ? "recording…" : rendering ? "rendering…" : playing ? "listening" : "ready when you are");
  return (
    <div className="v2-mosh-status" role="status" aria-live="polite" data-testid="v2-mosh-status">
      <span className="wave">⩘</span>
      <span>{text}</span>
    </div>
  );
}

function CollaboratorsCard() {
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const mpCreate = useStore((s) => s.mpCreateSession);
  const cameraOn = useVideo((s) => s.cameraOn);
  const localStream = useVideo((s) => s.localStream);
  const remoteStreams = useVideo((s) => s.remoteStreams);
  const toggleCamera = useVideo((s) => s.toggleCamera);
  const setHidden = useVideo((s) => s.setHidden);
  const teardown = useVideo((s) => s.teardown);
  const others = mp.active ? Object.entries(peers).filter(([id]) => id !== mp.selfPeer) : Object.entries(peers);

  // Release the camera on unmount + when the WebView is hidden (the light must not
  // stay on behind an invisible window) — mirrors the legacy Participants rail.
  useEffect(() => () => teardown(), [teardown]);
  useEffect(() => {
    const onVis = () => void setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [setHidden]);

  return (
    <section className="v2-card" data-testid="v2-collaborators">
      <div className="v2-card-head">
        <span>Collaborators</span>
        <button className={`v2-cam${cameraOn ? " on" : ""}`} data-testid="v2-camera-toggle" aria-pressed={cameraOn}
          title={cameraOn ? "Turn camera off" : "Share your camera"} onClick={() => void toggleCamera()}>
          {cameraOn ? "📹" : "📷"}
        </button>
      </div>
      <div className="v2-collab-list">
        {cameraOn && localStream && (
          <div className="v2-collab" data-testid="v2-collab-self">
            <VideoTile stream={localStream} muted label="Your camera" />
            <span className="nm">You</span>
          </div>
        )}
        {others.map(([id, p]) => (
          <div className="v2-collab" key={id} data-testid="v2-collab-peer">
            {remoteStreams[id]
              ? <VideoTile stream={remoteStreams[id]} label={`${p.name}'s camera`} />
              : <span className="av" style={{ background: p.color }}>{(p.name || "?").charAt(0).toUpperCase()}</span>}
            <span className="nm" title={p.name}>{p.name}</span>
            <span className="pulse">⩘</span>
          </div>
        ))}
        <button className="v2-invite" data-testid="v2-invite" onClick={() => { if (!mp.active) void mpCreate(); }}>
          ＋ Invite collaborator
        </button>
      </div>
    </section>
  );
}
