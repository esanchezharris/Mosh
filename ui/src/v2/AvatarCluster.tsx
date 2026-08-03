import { useStore } from "../store";

// Compact collaborator preview near the invite button. Hidden while solo.
export function AvatarCluster() {
  const peers = useStore((s) => s.peers);
  const selfPeer = useStore((s) => s.mp.selfPeer);
  const others = Object.entries(peers).filter(([id]) => id !== selfPeer);
  if (others.length === 0) return null;
  const shown = others.slice(0, 4);
  const extra = others.length - shown.length;
  return (
    <div className="v2-avatars" data-testid="v2-avatars" title={`${others.length} in the session`}>
      {shown.map(([id, peer]) => (
        <span key={id} className="v2-avatar" style={{ background: peer.color }} title={peer.name} aria-label={peer.name}>
          {(peer.name || "?").charAt(0).toUpperCase()}
        </span>
      ))}
      {extra > 0 && <span className="v2-avatar more" aria-label={`${extra} more`}>+{extra}</span>}
    </div>
  );
}
