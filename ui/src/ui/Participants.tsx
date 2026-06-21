// Session participants (redesign shell). Moshi is a participant in the room — the AI
// "player" — sitting alongside human collaborators, the same way a remote producer
// (or competitor) would join. Moshi's tile reuses his existing window; collaborator
// tiles are avatar + name today, with a video slot reserved for later.
import { useStore } from "../store";
import { Moshi } from "./Moshi";

export function Participants() {
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const others = mp.active ? Object.entries(peers).filter(([id]) => id !== mp.selfPeer) : [];

  return (
    <div className="participants" data-testid="participants">
      <div className="participants-head">Session</div>
      <div className="participant participant-moshi" data-testid="participant-moshi">
        <Moshi />
      </div>
      {others.map(([id, p]) => (
        <div key={id} className="participant participant-peer" data-testid="participant-peer">
          <span className="peer-avatar" style={{ background: p.color }}>{(p.name?.[0] ?? "?").toUpperCase()}</span>
          <span className="peer-name" title={p.name}>{p.name}</span>
          <span className="peer-video-stub" title="Video coming soon" aria-hidden="true">▢</span>
        </div>
      ))}
    </div>
  );
}
