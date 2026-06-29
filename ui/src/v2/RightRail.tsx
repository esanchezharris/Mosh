// The right rail: the MOSH card (the live WebGL character + a status line) and the
// COLLABORATORS card (peers + invite). It's a symmetric push-dock — collapsed it's a
// vertical pull-tab carrying the minimized Moshi mark (so the character is always present),
// open it expands its column. Moshi self-wires from the store, so the card just frames him.
// The status line narrates the agent's last move (agentUtter.say) with a transport/render
// fallback ladder. Video tiles land in the collaborators slice.

import { useEffect } from "react";
import { useStore } from "../store";
import { useShell } from "./shellState";
import { Moshi } from "../ui/Moshi";
import { MoshMark } from "./MoshMark";
import { IconCamera, IconCameraOff } from "../ui/icons";
import { useVideo } from "../webrtc/useVideo";
import { VideoTile } from "../ui/VideoTile";
import { PresenceMeter } from "./PresenceMeter";
import { Inspector } from "./inspector/Inspector";

export function RightRail() {
  const open = useShell((s) => s.rightOpen);
  const setOpen = useShell((s) => s.setRightOpen);
  const toggle = useShell((s) => s.toggleRight);

  return (
    <div className={`v2-dock v2-dock-right${open ? " open" : ""}`} data-testid="v2-right-dock">
      {open ? (
        <aside className="v2-rail" data-testid="v2-rail">
          <MoshCard onCollapse={() => setOpen(false)} />
          <Inspector />
          <CollaboratorsCard />
        </aside>
      ) : (
        /* the pull-tab — the minimized Moshi keeps the character present even when parked */
        <button className="v2-dock-tab v2-dock-tab-mosh" data-testid="v2-right-pull" aria-expanded={false}
          aria-label="Open agent panel" title="Mosh — agent · inspector · collaborators" onClick={toggle}>
          <MoshMark size={30} />
          <span className="v2-dock-tab-label">MOSH</span>
        </button>
      )}
    </div>
  );
}

function MoshCard({ onCollapse }: { onCollapse: () => void }) {
  return (
    <section className="v2-card v2-mosh-card" data-testid="v2-mosh-card">
      <div className="v2-card-head">
        <span>Mosh</span>
        <span className="v2-mosh-head-r">
          <span className="v2-live"><span className="led" /> Live</span>
          <button className="v2-rail-collapse" data-testid="v2-rail-collapse" aria-label="Hide agent panel"
            title="Hide" onClick={onCollapse}>⟩</button>
        </span>
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
      <span className="wave" aria-hidden>⩘</span>
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
          {cameraOn ? <IconCamera size={15} /> : <IconCameraOff size={15} />}
        </button>
      </div>
      <div className="v2-presence">
        {cameraOn && localStream && (
          <div className="v2-pcard" data-testid="v2-collab-self">
            <VideoTile stream={localStream} muted label="Your camera" />
            <div className="v2-pcard-meta">
              <span className="dot" />
              <span className="nm">You</span>
            </div>
          </div>
        )}
        {others.map(([id, p]) => {
          const stream = remoteStreams[id];
          const offline = p.online === false;
          return (
            <div className="v2-pcard" key={id} data-testid="v2-collab-peer" data-cam={stream ? "on" : "off"}>
              {stream
                ? <VideoTile stream={stream} label={`${p.name}'s camera`} />
                : <span className="v2-pcard-av" style={{ background: p.color }}>{(p.name || "?").charAt(0).toUpperCase()}</span>}
              <div className="v2-pcard-meta">
                <span className={`dot${offline ? " off" : ""}`} />
                <span className="nm" title={p.name}>{p.name}</span>
                {stream && <PresenceMeter stream={stream} />}
              </div>
            </div>
          );
        })}
        <button className="v2-invite" data-testid="v2-invite" onClick={() => { if (!mp.active) void mpCreate(); }}>
          ＋ Invite collaborator
        </button>
      </div>
    </section>
  );
}
