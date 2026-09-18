import { useStore } from "../store";
import { useV3 } from "./shellState";
import { IconBrowser, IconMixer, IconPlugins } from "./icons";

export function LeftRail() {
  const pane = useV3((s) => s.pane);
  const toggle = useV3((s) => s.togglePane);
  const posture = useV3((s) => s.posture);
  const view = useStore((s) => s.view);
  const mixer = posture === "studio" && view === "mixer";
  return (
    <div className="rail" data-testid="v3-rail">
      <button type="button" className={`ricon${pane === "browser" ? " on" : ""}`} title="Browser"
        aria-label="Browser" data-testid="v3-rail-browser" onClick={() => toggle("browser")}>
        <IconBrowser />
      </button>
      <button type="button" className={`ricon${pane === "plugins" ? " on" : ""}`} title="Plugins"
        aria-label="Plugins" data-testid="v3-rail-plugins" onClick={() => toggle("plugins")}>
        <IconPlugins />
      </button>
      <button type="button" className={`ricon${mixer ? " on" : ""}`}
        title={mixer ? "Return to arrangement" : "Mixer"} aria-label="Mixer" aria-pressed={mixer} data-testid="v3-rail-mixer"
        onClick={() => {
          useV3.getState().setPosture("studio");
          useStore.getState().setView(mixer ? "arrange" : "mixer");
        }}>
        <IconMixer />
      </button>
    </div>
  );
}
