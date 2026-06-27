// Are other collaborators in the session right now? Drives the v2 shell's two modes:
//  • peers present → the right rail (agent + collaborators) shows, as today.
//  • solo          → the rail collapses for a full-width timeline and the agent
//                    minimizes onto the prompt bar; the Inspector moves to a drawer.
// One source of truth so AppV2 / Composer / the inspector drawer never disagree.

import { useStore } from "../store";

export function useHasPeers(): boolean {
  return useStore((s) => {
    const ids = Object.keys(s.peers);
    return (s.mp.active ? ids.filter((id) => id !== s.mp.selfPeer) : ids).length > 0;
  });
}
