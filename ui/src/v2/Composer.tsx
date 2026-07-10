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
  return (
    <div className="v2-composer" data-testid="v2-composer">
      <div className="v2-composer-sticker">
        <MoshMark size={26} className="v2-composer-face" />
      </div>
      {snapshot && <div className="v2-composer-plus"><FileOptions snapshot={snapshot} /></div>}
      <div className="v2-composer-host">
        <AgentComposer />
      </div>
    </div>
  );
}
