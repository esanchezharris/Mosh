// The "Ask Mosh" composer bar. Wraps the existing AgentComposer (voice + text → the
// agent pipeline) so the whole brain/voice/fast-path stack is reused unchanged. The
// left "+" is the existing FileOptions control (File / Open / Save / Recent / Settings
// / Export / Samples via the shared runAction dispatcher) — demo-faithful and gives v2
// every app/file surface for free. Reference/hum affordances ride inside AgentComposer.

import { useStore } from "../store";
import { AgentComposer } from "../ui/AgentComposer";
import { FileOptions } from "../ui/FileOptions";
import { MoshMark } from "./MoshMark";

export function Composer() {
  const snapshot = useStore((s) => s.snapshot);
  // A narrow, centered prompt bar. The bar carries a small STATIC Moshi face as the send
  // cue (personality without a second WebGL canvas) — the live, "maximized" Moshi lives in
  // the always-on right rail, which is his only animated mount.
  return (
    <div className="v2-composer" data-testid="v2-composer">
      <MoshMark size={26} className="v2-composer-face" />
      {snapshot && <div className="v2-composer-plus"><FileOptions snapshot={snapshot} /></div>}
      <div className="v2-composer-host">
        <AgentComposer />
      </div>
    </div>
  );
}
