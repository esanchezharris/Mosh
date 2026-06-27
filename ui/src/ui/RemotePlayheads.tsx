import { memo, type CSSProperties } from "react";
import { useStore } from "../store";
import type { PeerInfo, PeerPresence } from "../multiplayer/sync";

export function RemotePlayheadsView({
  secToPx,
  lanesHeight,
  peerPresence,
  peers,
  nowMs = Date.now(),
}: {
  secToPx: (seconds: number) => number;
  lanesHeight: number;
  peerPresence: Record<string, PeerPresence>;
  peers: Record<string, PeerInfo>;
  nowMs?: number;
}) {
  const visible = Object.entries(peerPresence)
    .filter(([peerId, presence]) => peers[peerId]?.online && nowMs - presence.updatedAtMs < 8000)
    .sort(([a], [b]) => a.localeCompare(b));

  if (visible.length === 0) return null;

  return (
    <>
      {visible.map(([peerId, presence]) => {
        const peer = peers[peerId];
        const label = (peer?.name ?? peerId).trim() || peerId;
        return (
          <div
            key={peerId}
            className={`remote-playhead${presence.playing ? " playing" : ""}${presence.recording ? " recording" : ""}`}
            data-testid="remote-playhead"
            data-peer-id={peerId}
            data-pos={presence.position.toFixed(3)}
            style={{ left: secToPx(presence.position), height: lanesHeight, "--peer-color": peer?.color ?? "#ff69a8" } as CSSProperties}
          >
            <span className="remote-playhead-label">{label}</span>
          </div>
        );
      })}
    </>
  );
}

export const RemotePlayheads = memo(function RemotePlayheads({
  secToPx,
  lanesHeight,
}: {
  secToPx: (seconds: number) => number;
  lanesHeight: number;
}) {
  const peerPresence = useStore((s) => s.peerPresence);
  const peers = useStore((s) => s.peers);
  return <RemotePlayheadsView secToPx={secToPx} lanesHeight={lanesHeight} peerPresence={peerPresence} peers={peers} />;
});
