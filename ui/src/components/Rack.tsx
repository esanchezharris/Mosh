import { useStore } from "../store";
import type { Snapshot, Plugin } from "../types";
import { GenPanel } from "./GenPanel";

// The plugin rack for the selected track (Stage 3). Every action is a MoshOps
// command: load/remove/reorder/bypass/open_plugin_editor.
export function Rack({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const openBrowser = useStore((s) => s.openBrowser);
  const openAutomation = useStore((s) => s.openAutomation);
  const exec = useStore((s) => s.exec);

  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? null;
  // Show user-facing inserts: hosted VST3/AU (external), engine built-ins, and
  // Tier-A neural inserts. The auto track-fader (VolumeAndPan) stays hidden.
  const plugins = (track?.plugins ?? []).filter((p) => p.external || p.neural || p.builtin);

  return (
    <div className="rack">
      <div className="rack-left">
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
        {track && (
          <button
            className="rack-add"
            onClick={() => openAutomation(track.id)}
            title="Edit parameter automation for this track"
          >
            ⌁ Automation
          </button>
        )}
      </div>
      </div>
      {track && <GenPanel track={track} />}
    </div>
  );
}

function PluginCard({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const isNeural = !!plugin.neural;
  const isBuiltin = !!plugin.builtin;
  return (
    <div className={`pcard ${plugin.enabled ? "" : "bypassed"} ${isNeural ? "neural" : ""} ${isBuiltin ? "builtin" : ""}`}>
      <div className="pcard-head">
        <button
          className={`pdot ${plugin.enabled ? "on" : ""}`}
          title={plugin.enabled ? "Bypass" : "Enable"}
          onClick={() => exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })}
        />
        <span className="pname">{isNeural ? `Neural · ${plugin.neural!.model}` : plugin.name}</span>
        {plugin.isInstrument && <span className="ibadge">inst</span>}
        {isBuiltin && !plugin.isInstrument && <span className="ibadge bbadge">{plugin.category}</span>}
        {isNeural && <span className="ibadge nbadge">Tier A</span>}
      </div>

      {isNeural ? (
        <NeuralBody plugin={plugin} trackId={trackId} />
      ) : isBuiltin ? (
        <BuiltinBody plugin={plugin} trackId={trackId} />
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

// Built-in plugins have no native editor window (openEditor only pops out hosted
// VST3/AUs), so the rack drives them through their automatable params directly
// (set_plugin_param, normalised 0–1). Shows the first handful of params.
function BuiltinBody({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const params = (plugin.params ?? []).slice(0, 8);
  return (
    <div className="neural-body">
      {params.map((p) => (
        <label key={p.index} className="nparam">
          <span className="nlabel" title={p.name}>{p.name}</span>
          <span className="nslider">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={p.value}
              onChange={(e) => exec("set_plugin_param", { trackId, index: plugin.index, paramIndex: p.index, value: Number(e.target.value) })}
            />
          </span>
          <span className="nval">{Math.round(p.value * 100)}</span>
        </label>
      ))}
      {params.length === 0 && <span className="rack-empty">no params</span>}
      <div className="neural-row">
        <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })} title="Move left">‹</button>
        <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })} title="Move right">›</button>
        <button className="x" onClick={() => exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
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
