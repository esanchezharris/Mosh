// The left BROWSER dock — a push-dock that lives in its OWN grid column at the left edge.
// Collapsed, it's just a vertical pull-tab; open, it expands its column to a panel (so it
// pushes the centered arrangement rather than covering it). One surface for both halves of
// "what do I drop in?": SOUNDS (the file browser → drag onto a lane / import) and PLUGINS
// (built-ins + scanned VST3/AU → load onto the selected track). SOUNDS reuses SampleBrowser;
// PLUGINS hosts PluginDock — the v2 plugin browser (there's no plugin modal in v2; the FX
// rack's "+ Plugin" opens this dock on the Plugins tab via openBrowserTab). Open/tab state
// is UI-local (shellState). AppV2 owns the open subscription and passes it here so the
// shell column width and drawer contents cannot render from separate subscription turns.

import { useShell } from "./shellState";
import { SampleBrowser } from "../ui/SampleBrowser";
import { PluginDock } from "./PluginBrowser";
import { IconClose, IconFolder } from "../ui/icons";

export function LeftDrawer({ open }: { open: boolean }) {
  const tab = useShell((s) => s.browserTab);
  const toggle = useShell((s) => s.toggleBrowser);
  const openTab = useShell((s) => s.openBrowserTab);
  const setOpen = useShell((s) => s.setBrowserOpen);
  const tabSummary =
    tab === "sounds"
      ? "Browse folders, recent imports, and audio files."
      : "Search collections and load plugins onto the selected track.";

  return (
    <div className={`v2-dock v2-dock-left${open ? " open" : ""}`} data-testid="v2-browser-drawer">
      {open ? (
        <div className="v2-dock-panel" role="region" aria-label="Browser">
          <div className="v2-dock-head">
            <div className="v2-dock-headcopy">
              <span className="v2-dock-title">Browser</span>
              <span className="v2-dock-subtitle">{tabSummary}</span>
            </div>
            <button
              className="v2-dock-close"
              data-testid="v2-browser-close"
              aria-label="Close browser"
              title="Close"
              onClick={() => setOpen(false)}
            >
              <IconClose size={14} />
              <span className="v2-dock-close-label">Close</span>
            </button>
          </div>
          <div className="v2-dock-tabs" role="tablist" aria-label="Browser sections">
            <button
              id="v2-browser-tab-sounds"
              role="tab"
              aria-selected={tab === "sounds"}
              aria-controls="v2-browser-panel-sounds"
              className={tab === "sounds" ? "on" : ""}
              data-testid="v2-browser-tab-sounds"
              onClick={() => openTab("sounds")}
            >
              Sounds
            </button>
            <button
              id="v2-browser-tab-plugins"
              role="tab"
              aria-selected={tab === "plugins"}
              aria-controls="v2-browser-panel-plugins"
              className={tab === "plugins" ? "on" : ""}
              data-testid="v2-browser-tab-plugins"
              onClick={() => openTab("plugins")}
            >
              Plugins
            </button>
          </div>
          <div className="v2-dock-body">
            {tab === "sounds" ? (
              <div id="v2-browser-panel-sounds" role="tabpanel" aria-labelledby="v2-browser-tab-sounds">
                <SampleBrowser />
              </div>
            ) : (
              <div id="v2-browser-panel-plugins" role="tabpanel" aria-labelledby="v2-browser-tab-plugins">
                <PluginDock />
              </div>
            )}
          </div>
        </div>
      ) : (
        /* the pull-tab — the only chrome visible when the dock is parked */
        <button className="v2-dock-tab" data-testid="v2-browser-pull" aria-expanded={false}
          aria-label="Open browser" title="Browser — samples & plugins" onClick={toggle}>
          <span className="v2-dock-tab-icon" aria-hidden><IconFolder size={16} /></span>
          <span className="v2-dock-tab-label">BROWSER</span>
        </button>
      )}
    </div>
  );
}
