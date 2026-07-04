// The left BROWSER dock — a push-dock that lives in its OWN grid column at the left edge.
// Collapsed, it's just a vertical pull-tab; open, it expands its column to a panel (so it
// pushes the centered arrangement rather than covering it). One surface for both halves of
// "what do I drop in?": SOUNDS (the file browser → drag onto a lane / import) and PLUGINS
// (built-ins + scanned VST3/AU → load onto the selected track). SOUNDS reuses SampleBrowser;
// PLUGINS hosts PluginDock — the v2 plugin browser (there's no plugin modal in v2; the FX
// rack's "+ Plugin" opens this dock on the Plugins tab via openBrowserTab). Open/tab state
// is UI-local (shellState) and drives the column width via data-left-open on the shell.

import { useShell } from "./shellState";
import { SampleBrowser } from "../ui/SampleBrowser";
import { PluginDock } from "./PluginBrowser";

export function LeftDrawer() {
  const open = useShell((s) => s.browserOpen);
  const tab = useShell((s) => s.browserTab);
  const toggle = useShell((s) => s.toggleBrowser);
  const openTab = useShell((s) => s.openBrowserTab);
  const setOpen = useShell((s) => s.setBrowserOpen);

  return (
    <div className={`v2-dock v2-dock-left${open ? " open" : ""}`} data-testid="v2-browser-drawer">
      {open ? (
        <div className="v2-dock-panel" role="region" aria-label="Browser">
          <div className="v2-dock-head">
            <div className="v2-dock-tabs" role="tablist" aria-label="Browser sections">
              <button role="tab" aria-selected={tab === "sounds"} className={tab === "sounds" ? "on" : ""}
                data-testid="v2-browser-tab-sounds" onClick={() => openTab("sounds")}>Sounds</button>
              <button role="tab" aria-selected={tab === "plugins"} className={tab === "plugins" ? "on" : ""}
                data-testid="v2-browser-tab-plugins" onClick={() => openTab("plugins")}>Plugins</button>
            </div>
            <button className="v2-dock-close" data-testid="v2-browser-close" aria-label="Close browser" title="Close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="v2-dock-body">
            {tab === "sounds" ? <SampleBrowser /> : <PluginDock />}
          </div>
        </div>
      ) : (
        /* the pull-tab — the only chrome visible when the dock is parked */
        <button className="v2-dock-tab" data-testid="v2-browser-pull" aria-expanded={false}
          aria-label="Open browser" title="Browser — samples & plugins" onClick={toggle}>
          <span className="v2-dock-tab-label">BROWSER</span>
        </button>
      )}
    </div>
  );
}
