import { PluginDock } from "../v2/PluginBrowser";

export function PluginsPane() {
  return (
    <aside className="side-pane" data-testid="v3-plugins-pane">
      <div className="pane-hd"><span className="sec">Plugins</span></div>
      <PluginDock />
      <div className="pane-foot">Editors open natively · chain stays in Mix</div>
    </aside>
  );
}
