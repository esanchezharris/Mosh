import { useStore } from "../store";
import type { Snapshot, Plugin } from "../types";

// The plugin rack for the selected track (Stage 3). Every action is a MoshOps
// command: load/remove/reorder/bypass/open_plugin_editor.
export function Rack({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const openBrowser = useStore((s) => s.openBrowser);
  const exec = useStore((s) => s.exec);

  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? null;
  // Show user-facing inserts: hosted VST3s (external) + Tier-A neural inserts.
  const plugins = (track?.plugins ?? []).filter((p) => p.external || p.neural);

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
          <button className="rack-add" onClick={openBrowser} title="Add VST3 plugin">
            + Plugin
          </button>
        )}
        {track && (
          <button
            className="rack-add"
            onClick={() => exec("add_neural_insert", { trackId: track.id, modelId: "nam" })}
            title="Add a Tier-A real-time neural insert"
          >
            + Neural
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
  const isNeural = !!plugin.neural;
  return (
    <div className={`pcard ${plugin.enabled ? "" : "bypassed"} ${isNeural ? "neural" : ""}`}>
      <div className="pcard-head">
        <button
          className={`pdot ${plugin.enabled ? "on" : ""}`}
          title={plugin.enabled ? "Bypass" : "Enable"}
          onClick={() => exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })}
        />
        <span className="pname">{isNeural ? `Neural · ${plugin.neural!.model}` : plugin.name}</span>
        {plugin.isInstrument && <span className="ibadge">inst</span>}
        {isNeural && <span className="ibadge nbadge">Tier A</span>}
      </div>

      {isNeural ? (
        <NeuralBody plugin={plugin} trackId={trackId} />
      ) : (
        <div className="pcard-actions">
          <button onClick={() => exec("open_plugin_editor", { trackId, index: plugin.index })}>Edit</button>
          <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })} title="Move left">‹</button>
          <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })} title="Move right">›</button>
          <button className="x" onClick={() => exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
        </div>
      )}
    </div>
  );
}

function NeuralBody({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const n = plugin.neural!;
  return (
    <div className="neural-body">
      {n.params.map((p) => (
        <label key={p.id} className="nparam">
          <span className="nlabel">{p.id}</span>
          <span className="nslider">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(p.ui)}
              onChange={(e) => exec("set_neural_param", { trackId, index: plugin.index, paramId: p.id, value: Number(e.target.value) })}
            />
            {/* ASTD clamp marker: the quality-collapse point on the 0–100 track */}
            {!n.labMode && p.safeMaxUi < 100 && (
              <span className="astd-mark" style={{ left: `${p.safeMaxUi}%` }} title="ASTD safe limit" />
            )}
          </span>
          <span className="nval">{Math.round(p.ui)}</span>
        </label>
      ))}
      <div className="neural-row">
        <button
          className={`mixbtn ${n.labMode ? "lab-on" : ""}`}
          title="Lab mode — unlock the raw range beyond the ASTD clamp"
          onClick={() => exec("set_neural_lab_mode", { trackId, index: plugin.index, on: !n.labMode })}
        >
          {n.labMode ? "⚠ LAB" : "Lab"}
        </button>
        <button onClick={() => exec("reset_neural", { trackId, index: plugin.index })} title="Reset model state">Reset</button>
        <span className="nlat">{(n.latencySeconds * 1000).toFixed(1)} ms</span>
        <button className="x" onClick={() => exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
    </div>
  );
}
