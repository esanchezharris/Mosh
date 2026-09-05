import { useV3 } from "./shellState";
import { IconBrowser, IconMixer, IconPlugins } from "./icons";

export function LeftRail() {
  const pane = useV3((s) => s.pane);
  const toggle = useV3((s) => s.togglePane);
  const posture = useV3((s) => s.posture);
  const active = posture === "booth" && pane === "none" ? "mixer" : pane;
  return (
    <div className="rail" data-testid="v3-rail">
      <button type="button" className={`ricon${active === "browser" ? " on" : ""}`} title="Browser"
        aria-label="Browser" data-testid="v3-rail-browser" onClick={() => toggle("browser")}>
        <IconBrowser />
      </button>
      <button type="button" className={`ricon${active === "plugins" ? " on" : ""}`} title="Plugins"
        aria-label="Plugins" data-testid="v3-rail-plugins" onClick={() => toggle("plugins")}>
        <IconPlugins />
      </button>
      <button type="button" className={`ricon${active === "mixer" || (posture === "booth" && pane === "none") ? " on" : ""}`}
        title="Mixer" aria-label="Mixer" data-testid="v3-rail-mixer"
        onClick={() => useV3.getState().setPane("none")}>
        <IconMixer />
      </button>
    </div>
  );
}
