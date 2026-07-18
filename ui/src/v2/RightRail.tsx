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
import { IconCamera, IconCameraOff, IconChevronLeft, IconSpark, IconUsers } from "../ui/icons";
import { useVideo } from "../webrtc/useVideo";
import { VideoTile } from "../ui/VideoTile";
import { PresenceMeter } from "./PresenceMeter";
import { Inspector } from "./inspector/Inspector";
import { MultiplayerLauncher } from "./MultiplayerLauncher";

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
          <MasterCard />
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
            title="Hide" onClick={onCollapse}><IconChevronLeft size={14} /></button>
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
      <span className="wave" aria-hidden><IconSpark size={13} /></span>
      <span>{text}</span>
    </div>
  );
}

// CONF-MASTER-VOL — the master bus fader/pan. set_master_volume/set_master_pan have
// existed natively (and agent-callable) since Wave 5 with no UI surface anywhere in
// v2; this is that surface. Lives in the rail next to the per-track Inspector Mix tab
// (the closest thing v2 has to a mixer strip) rather than the TopBar, which stays
// dedicated to transport/project chrome. Reuses the Inspector's .v2-mix/.v2-field
// layout verbatim so a master fader reads as the same control family as a track one.
export function MasterCard() {
  const exec = useStore((s) => s.exec);
  const master = useStore((s) => s.snapshot?.master);
  return (
    <section className="v2-card v2-master-card" data-testid="v2-master-card">
      <div className="v2-card-head"><span>Master</span></div>
      <div className="v2-mix v2-master-body">
        <label className="v2-field">
          <span>Vol</span>
          <input type="range" min={-48} max={6} step={0.5} value={master?.volumeDb ?? 0}
            aria-label="Master volume" data-testid="v2-master-volume"
            onChange={(e) => void exec("set_master_volume", { db: Number(e.target.value) })} />
          <span className="v2-val">{(master?.volumeDb ?? 0).toFixed(1)}</span>
        </label>
        <label className="v2-field">
          <span>Pan</span>
          <input type="range" min={-1} max={1} step={0.02} value={master?.pan ?? 0}
            aria-label="Master pan" data-testid="v2-master-pan"
            onChange={(e) => void exec("set_master_pan", { pan: Number(e.target.value) })} />
          <span className="v2-val">{Math.round((master?.pan ?? 0) * 100)}</span>
        </label>
      </div>
    </section>
  );
}

function CollaboratorsCard() {
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const cameraOn = useVideo((s) => s.cameraOn);
  const localStream = useVideo((s) => s.localStream);
  const remoteStreams = useVideo((s) => s.remoteStreams);
  const toggleCamera = useVideo((s) => s.toggleCamera);
  const setHidden = useVideo((s) => s.setHidden);
  const teardown = useVideo((s) => s.teardown);
  const others = mp.active ? Object.entries(peers).filter(([id]) => id !== mp.selfPeer) : Object.entries(peers);
  const collaborationActive = mp.active || cameraOn || !!localStream || others.length > 0;

  // Release the camera on unmount + when the WebView is hidden (the light must not
  // stay on behind an invisible window) — mirrors the legacy Participants rail.
  useEffect(() => () => teardown(), [teardown]);
  useEffect(() => {
    const onVis = () => void setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [setHidden]);

  return (
    <section className="v2-card v2-collab-card" data-testid="v2-collaborators" data-active={collaborationActive ? "true" : "false"}>
      <div className="v2-card-head">
        <span>Collaborators</span>
        {collaborationActive ? (
          <button className={`v2-cam${cameraOn ? " on" : ""}`} data-testid="v2-camera-toggle" aria-pressed={cameraOn}
            title={cameraOn ? "Turn camera off" : "Share your camera"} onClick={() => void toggleCamera()}>
            {cameraOn ? <IconCamera size={15} /> : <IconCameraOff size={15} />}
          </button>
        ) : (
          <span className="v2-collab-kicker">Invite when ready</span>
        )}
      </div>
      <div className="v2-presence">
        {!collaborationActive ? (
          <div className="v2-collab-empty" data-testid="v2-collab-empty">
            <div className="v2-collab-empty-icon" aria-hidden><IconUsers size={18} /></div>
            <div className="v2-collab-empty-copy">
              <strong>Share when you need a second seat.</strong>
              <span>Camera stays off until you explicitly join collaboration.</span>
            </div>
            <MultiplayerLauncher
              className="v2-invite"
              testId="v2-invite"
              ariaLabel="Create or join a multiplayer session"
              label={<><IconUsers size={15} /><span>Invite collaborator</span></>}
            />
          </div>
        ) : (
          <>
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
            <div className="v2-collab-actions">
              <MultiplayerLauncher
                className="v2-invite"
                testId="v2-invite"
                ariaLabel={mp.active ? "Multiplayer session — view room code" : "Create or join a multiplayer session"}
                label={<><IconUsers size={15} /><span>{mp.active ? "Share session" : "Invite collaborator"}</span></>}
              />
              {!cameraOn && <span className="v2-collab-hint">Camera stays off until you decide to share it.</span>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
