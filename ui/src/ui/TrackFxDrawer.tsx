// Per-track FX drawer (redesign shell): a compact list of the track's plugin/FX
// chain, opened from the track header. Most plugins are 3rd-party, so each row is
// just a name + bypass + a button that pops out the native plugin window — the deep
// param editing lives in the plugin's own window, not here. Same command seam the
// bottom-dock rack uses (bypass_plugin / open_plugin_editor / remove_plugin).
import { useStore } from "../store";
import type { Track } from "../types";

export function TrackFxDrawer({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const openBrowser = useStore((s) => s.openBrowser);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const raveAvailable = useStore((s) => s.snapshot?.session?.raveAvailable ?? false);
  const plugins = (track.plugins ?? []).filter((p) => p.external || p.rave || p.builtin);

  return (
    <div className="fxdrawer" data-testid="fx-drawer" data-track-id={track.id}>
      {plugins.length === 0 && <div className="fx-empty">No effects yet</div>}
      {plugins.map((p) => (
        <div key={p.index} className={`fx-row${p.enabled ? "" : " bypassed"}`} data-testid="fx-row">
          <button className={`pdot${p.enabled ? " on" : ""}`} title={p.enabled ? "Bypass" : "Enable"}
            aria-pressed={!p.enabled}
            onClick={() => void exec("bypass_plugin", { trackId: track.id, index: p.index, bypassed: p.enabled })} />
          <span className="fx-name" title={p.name}>{p.rave ? `RAVE · ${p.rave.model}` : p.name}</span>
          <button className="btn fx-open" title="Open plugin window" aria-label={`Open ${p.name}`}
            onClick={() => void exec("open_plugin_editor", { trackId: track.id, index: p.index })}>⤢</button>
          <button className="btn x" title="Remove" aria-label={`Remove ${p.name}`}
            onClick={() => void exec("remove_plugin", { trackId: track.id, index: p.index })}>✕</button>
        </div>
      ))}
      <div className="fx-add">
        <button className="btn" onClick={() => { setSelectedTrack(track.id); openBrowser(); }}>+ Plugin</button>
        {raveAvailable && (
          <button className="btn" data-testid="fx-add-rave" title="Add a real-time RAVE timbre-transfer insert"
            onClick={() => void exec("add_rave_insert", { trackId: track.id })}>+ RAVE</button>
        )}
      </div>
    </div>
  );
}
