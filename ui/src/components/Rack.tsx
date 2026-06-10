import { useState } from "react";
import { useStore } from "../store";
import type { Snapshot, Plugin } from "../types";
import { GenPanel } from "./GenPanel";
import { DrumRackPanel, trackHasRack } from "./DrumRackPanel";
import { PianoRoll } from "./PianoRoll";
import { MixerPanel } from "./MixerPanel";

// Builtin device types the "+ Device" menu can load (load_builtin_plugin).
const BUILTIN_TYPES = [
  "sampler", "4osc", "eq", "compressor", "delay", "reverb",
  "lowpass", "chorus", "phaser",
] as const;

// The plugin rack for the selected track (Stage 3, opened up in Stage 15).
// Shows EVERY device on the chain — builtins included (they were filtered out
// before, which made the sampler/EQ/etc. invisible and unloadable). The meter
// tap never appears (snapshot-invisible); VolumeAndPan is hidden here because
// the track header IS its UI.
export function Rack({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const openBrowser = useStore((s) => s.openBrowser);
  const exec = useStore((s) => s.exec);
  const editingClipId = useStore((s) => s.editingClipId);
  const mixerOpen = useStore((s) => s.mixerOpen);

  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? null;
  const plugins = (track?.plugins ?? []).filter((p) => p.type !== "volume");

  // GenPanel is collapsible (Stage 15): open automatically only when the
  // track already has a render layer to show.
  const hasLayer = !!track?.clips.some((c) => c.hasRenderLayer);
  const [genOpenManual, setGenOpenManual] = useState<boolean | null>(null);
  const genOpen = genOpenManual ?? hasLayer;

  // Piano roll drawer (Stage 16): editing a clip swaps the whole rack area.
  // MUST come AFTER every hook above — an early return before useState made
  // React render fewer hooks than the previous pass and crash the UI the
  // moment a clip was double-clicked (Emilio's repro).
  if (editingClipId)
    return (
      <div className="rack tall">
        <PianoRoll snapshot={snapshot} />
      </div>
    );

  // Mixer view (Stage 17) — same drawer-swap pattern, same hook rule.
  if (mixerOpen)
    return (
      <div className="rack tall">
        <MixerPanel snapshot={snapshot} />
      </div>
    );

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
            <PluginCard key={`${p.index}-${p.type}`} plugin={p} trackId={track.id} />
          ))}
        {track && plugins.length === 0 && <span className="rack-empty">no devices</span>}
        {track && (
          <select
            className="rack-add device-menu"
            value=""
            title="Add a builtin device"
            onChange={(e) => {
              if (e.target.value) void exec("load_builtin_plugin", { trackId: track.id, type: e.target.value });
              e.target.value = "";
            }}
          >
            <option value="" disabled>+ Device</option>
            {BUILTIN_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}
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
            className={`rack-add ${genOpen ? "on" : ""}`}
            onClick={() => setGenOpenManual(!genOpen)}
            title="Generative layer (Tier B)"
          >
            ✨ Gen
          </button>
        )}
      </div>
      </div>
      {/* FL-style step sequencer over the track's sampler pads (Stage 14). */}
      {trackHasRack(track) && <DrumRackPanel track={track} />}
      {track && genOpen && <GenPanel track={track} />}
    </div>
  );
}

function PluginCard({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const isNeural = !!plugin.neural;
  const isBuiltin = !plugin.external && !isNeural;
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
        <>
          {plugin.type === "compressor" && <SidechainKey plugin={plugin} trackId={trackId} />}
          {isBuiltin && <BuiltinParams plugin={plugin} trackId={trackId} />}
          <div className="pcard-actions">
            {plugin.external && (
              <button onClick={() => exec("open_plugin_editor", { trackId, index: plugin.index })}>Edit</button>
            )}
            <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })} title="Move left">‹</button>
            <button onClick={() => exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })} title="Move right">›</button>
            <button className="x" onClick={() => exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
          </div>
        </>
      )}
    </div>
  );
}

// Sidechain key picker (Stage 17): compressors can be keyed from any other
// track — set_sidechain wires setSidechainSourceID + guessSidechainRouting.
function SidechainKey({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const tracks = useStore((s) => s.snapshot?.tracks ?? []);
  return (
    <label className="sc-key" title="Sidechain key source">
      <span className="blabel">key</span>
      <select
        value={plugin.sidechainSourceId ?? ""}
        onChange={(e) =>
          e.target.value &&
          exec("set_sidechain", { trackId, index: plugin.index, sourceTrackId: e.target.value })
        }
      >
        <option value="">none</option>
        {tracks
          .filter((t) => t.id !== trackId)
          .map((t) => (
            <option key={t.id} value={t.id}>{t.name || `Track ${t.index + 1}`}</option>
          ))}
      </select>
    </label>
  );
}

// Generic param sliders for builtin devices (Stage 15): the snapshot already
// ships the first 16 automatable params; expose the first few so an EQ or
// compressor is usable without a dedicated editor.
function BuiltinParams({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const params = plugin.params.slice(0, 6);
  if (params.length === 0) return null;
  return (
    <div className="bparams">
      {params.map((p) => (
        <label key={p.index} className="bparam" title={p.name}>
          <span className="blabel">{p.name.length > 9 ? p.name.slice(0, 8) + "…" : p.name}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p.value}
            onChange={(e) =>
              exec("set_plugin_param", {
                trackId,
                index: plugin.index,
                paramIndex: p.index,
                value: Number(e.target.value),
              })
            }
          />
        </label>
      ))}
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
