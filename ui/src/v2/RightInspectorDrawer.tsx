// The Inspector's home in SOLO mode (no collaborators). When the right rail collapses to
// reclaim space, the contextual Inspector (Mix · FX · Gen · MIDI · Takes) moves into a
// right-edge slide-out drawer that mirrors the left browser dock. It opens on its pull-tab
// or automatically when a clip is selected (setSelectedClip flips inspectorOpen). The
// Inspector component itself is reused verbatim — same surface as the rail uses with peers.

import { useShell } from "./shellState";
import { Inspector } from "./inspector/Inspector";

export function RightInspectorDrawer() {
  const open = useShell((s) => s.inspectorOpen);
  const setOpen = useShell((s) => s.setInspectorOpen);

  return (
    <div className={`v2-rdrawer${open ? " open" : ""}`} data-testid="v2-inspector-drawer">
      <button className="v2-rdrawer-tab" data-testid="v2-inspector-pull" aria-expanded={open}
        aria-label={open ? "Close inspector" : "Open inspector"} title="Inspector — mix, FX, generate"
        onClick={() => setOpen(!open)}>
        <span className="v2-drawer-tab-label">INSPECTOR</span>
      </button>
      <div className="v2-rdrawer-panel" role="region" aria-label="Inspector" aria-hidden={!open}>
        {open && (
          <>
            <div className="v2-drawer-head v2-rdrawer-head">
              <button className="v2-drawer-close" data-testid="v2-inspector-close" aria-label="Close inspector" title="Close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="v2-drawer-body v2-rdrawer-body">
              <Inspector />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
