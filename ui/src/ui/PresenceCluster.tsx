// Top-right presence cluster (redesign shell): collaborator avatars + an AI-active
// pill + Share. Always-on in the redesign default — "who's here / is the agent
// working". Lightweight presence only; collaborator video lives in the right rail
// (deferred). Reads the same multiplayer + agentBusy state the existing panels use.
import { useStore } from "../store";

export function PresenceCluster() {
  const agentBusy = useStore((s) => s.agentBusy);
  const mp = useStore((s) => s.mp);
  const peers = useStore((s) => s.peers);
  const entries = mp.active ? Object.entries(peers) : [];

  return (
    <div className="presence" data-testid="presence">
      {entries.length > 0 && (
        <div className="presence-avatars" aria-label="Collaborators">
          {entries.map(([id, p]) => (
            <span key={id} className="avatar" style={{ background: p.color }} title={p.name}>
              {(p.name?.[0] ?? "?").toUpperCase()}
            </span>
          ))}
        </div>
      )}
      <span className="ai-pill" data-testid="ai-pill" data-state={agentBusy ? "active" : "idle"}
        title={agentBusy ? "Agent is working" : "Agent idle"}>
        AI{agentBusy ? " · active" : ""}
      </span>
      <button className="btn share-btn" data-testid="share" title="Share this session">Share</button>
    </div>
  );
}
