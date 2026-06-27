// The left BROWSER drawer — an FL/Ableton-style dock that slides in from the left edge
// on a pull-tab. One surface for both halves of "what do I drop in?": SOUNDS (the file
// browser → drag onto a lane / import) and PLUGINS (built-ins + scanned VST3/AU → load
// onto the selected track). SOUNDS reuses SampleBrowser; PLUGINS hosts PluginDock — the
// compact form of the same plugin picker the "+ Plugin" modal uses (shared collections +
// list, just a chip row instead of a wide rail). Open/tab state is UI-local (shellState).

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
    <div className={`v2-drawer${open ? " open" : ""}`} data-testid="v2-browser-drawer">
      <div className="v2-drawer-panel" role="region" aria-label="Browser" aria-hidden={!open}>
        {open && (
          <>
            <div className="v2-drawer-head">
              <div className="v2-drawer-tabs" role="tablist" aria-label="Browser sections">
                <button role="tab" aria-selected={tab === "sounds"} className={tab === "sounds" ? "on" : ""}
                  data-testid="v2-browser-tab-sounds" onClick={() => openTab("sounds")}>Sounds</button>
                <button role="tab" aria-selected={tab === "plugins"} className={tab === "plugins" ? "on" : ""}
                  data-testid="v2-browser-tab-plugins" onClick={() => openTab("plugins")}>Plugins</button>
              </div>
              <button className="v2-drawer-close" data-testid="v2-browser-close" aria-label="Close browser" title="Close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="v2-drawer-body">
              {tab === "sounds" ? <SampleBrowser /> : <PluginDock />}
            </div>
          </>
        )}
      </div>
      {/* the pull-tab — the only chrome visible when the drawer is parked off-screen */}
      <button className="v2-drawer-tab" data-testid="v2-browser-pull" aria-expanded={open}
        aria-label={open ? "Close browser" : "Open browser"} title="Browser — samples & plugins" onClick={toggle}>
        <span className="v2-drawer-tab-label">BROWSER</span>
      </button>
    </div>
  );
}
