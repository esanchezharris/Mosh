// Session participants (redesign shell). Moshi is a participant in the room — the AI
// "player" — sitting alongside human collaborators, the same way a remote producer
// (or competitor) would join. A camera toggle (off by default) shares your video; peer
// tiles show a collaborator's live video once they share, falling back to an avatar.
import { useEffect } from "react";
import { useStore } from "../store";
import { useVideo } from "../webrtc/useVideo";
import { Moshi } from "./Moshi";
import { VideoTile } from "./VideoTile";

export function Participants() {
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const cameraOn = useVideo((s) => s.cameraOn);
  const localStream = useVideo((s) => s.localStream);
  const remoteStreams = useVideo((s) => s.remoteStreams);
  const toggleCamera = useVideo((s) => s.toggleCamera);
  const teardown = useVideo((s) => s.teardown);
  const others = mp.active ? Object.entries(peers).filter(([id]) => id !== mp.selfPeer) : [];

  // Release the camera when the rail unmounts (defense-in-depth on top of toggle-off).
  useEffect(() => () => teardown(), [teardown]);

  return (
    <div className="participants" data-testid="participants">
      <div className="participants-head">
        <span>Session</span>
        {/* Always available so you can preview/check your camera; it's shared with peers
            only once you're in a session with them. Off by default (privacy). */}
        <button
          className={`btn icon cam-toggle${cameraOn ? " on" : ""}`}
          data-testid="camera-toggle"
          aria-pressed={cameraOn}
          title={cameraOn ? "Turn camera off" : "Share your camera"}
          onClick={() => void toggleCamera()}
        >
          <span aria-hidden="true">{cameraOn ? "📹" : "📷"}</span>
        </button>
      </div>
      <div className="participant participant-moshi" data-testid="participant-moshi">
        <Moshi />
      </div>
      {cameraOn && localStream && (
        <div className="participant participant-self" data-testid="participant-self">
          <VideoTile stream={localStream} muted label="Your camera" />
          <span className="peer-name">You</span>
        </div>
      )}
      {others.map(([id, p]) => (
        <div key={id} className="participant participant-peer" data-testid="participant-peer">
          {remoteStreams[id] ? (
            <VideoTile stream={remoteStreams[id]} label={`${p.name}'s camera`} />
          ) : (
            <span className="peer-avatar" style={{ background: p.color }}>{(p.name?.[0] ?? "?").toUpperCase()}</span>
          )}
          <span className="peer-name" title={p.name}>{p.name}</span>
        </div>
      ))}
    </div>
  );
}
