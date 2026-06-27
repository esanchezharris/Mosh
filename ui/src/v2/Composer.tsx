// The "Ask Mosh" composer bar. Wraps the existing AgentComposer (voice + text → the
// agent pipeline) so the whole brain/voice/fast-path stack is reused unchanged. The
// left "+" is the existing FileOptions control (File / Open / Save / Recent / Settings
// / Export / Samples via the shared runAction dispatcher) — demo-faithful and gives v2
// every app/file surface for free. Reference/hum affordances ride inside AgentComposer.

import { useStore } from "../store";
import { AgentComposer } from "../ui/AgentComposer";
import { FileOptions } from "../ui/FileOptions";
import { Moshi } from "../ui/Moshi";
import { MoshMark } from "./MoshMark";
import { useHasPeers } from "./usePresence";

export function Composer() {
  const snapshot = useStore((s) => s.snapshot);
  // Solo (no collaborators): the agent minimizes onto the prompt bar — the live Moshi
  // character rides the bar's left edge (the rail isn't shown, so this is his only mount).
  // With collaborators present he lives in the right rail, and the bar shows the static mark.
  const hasPeers = useHasPeers();
  const solo = !hasPeers;
  return (
    <div className={`v2-composer${solo ? " solo" : ""}`} data-testid="v2-composer">
      {solo
        ? <div className="v2-composer-agent" data-testid="v2-composer-agent"><Moshi /></div>
        : <MoshMark size={26} className="v2-composer-face" />}
      {snapshot && <div className="v2-composer-plus"><FileOptions snapshot={snapshot} /></div>}
      <div className="v2-composer-host">
        <AgentComposer />
      </div>
    </div>
  );
}
