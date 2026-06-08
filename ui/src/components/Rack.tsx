import { useStore } from "../store";
import type { Snapshot, Plugin } from "../types";

// The plugin rack for the selected track (Stage 3). Every action is a MoshOps
// command: load/remove/reorder/bypass/open_plugin_editor.
export function Rack({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const openBrowser = useStore((s) => s.openBrowser);
  const exec = useStore((s) => s.exec);

  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? null;
  const plugins = (track?.plugins ?? []).filter((p) => p.external);

  return (
    <div className="rack">
      <div className="rack-label">
        {track ? (
          <>
            chain · <b>{track.name || `Track ${track.index + 1}`}</b>
          </>
        ) : (
          "select a track"
        )}
      </div>
      <div className="rack-chain">
        {track &&
          plugins.map((p) => (
            <PluginCard key={p.index} plugin={p} trackId={track.id} />
          ))}
        {track && plugins.length === 0 && <span className="rack-empty">no plugins</span>}
        {track && (
          <button className="rack-add" onClick={openBrowser} title="Add plugin">
            + Plugin
          </button>
        )}
        {track && (
          <button
            className="rack-add"
            onClick={() => exec("add_midi_clip", { trackId: track.id })}
            title="Add a MIDI clip with a default arpeggio"
          >
            + MIDI
          </button>
        )}
      </div>
    </div>
  );
}

function PluginCard({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  return (
    <div className={`pcard ${plugin.enabled ? "" : "bypassed"}`}>
      <div className="pcard-head">
        <button
          className={`pdot ${plugin.enabled ? "on" : ""}`}
          title={plugin.enabled ? "Bypass" : "Enable"}
          onClick={() => exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })}
        />
        <span className="pname">{plugin.name}</span>
        {plugin.isInstrument && <span className="ibadge">inst</span>}
      </div>
      <div className="pcard-actions">
        <button onClick={() => exec("open_plugin_editor", { trackId, index: plugin.index })}>Edit</button>
        <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })} title="Move left">‹</button>
        <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })} title="Move right">›</button>
        <button className="x" onClick={() => exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
    </div>
  );
}
