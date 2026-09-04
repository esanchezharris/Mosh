// The plugin/neural RACK (Stage 3/4) for the selected track. Extracted verbatim from
// Dock.tsx so both shells (classic Dock, v2 Inspector) import it without pulling in the
// classic-only Dock wrapper. Same command seam, same arg shapes.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Plugin, Track } from "../types";

export function Rack({ track, onAddPlugin }: { track: Track | null; onAddPlugin?: () => void }) {
  const openBrowser = useStore((s) => s.openBrowser);
  const openAutomation = useStore((s) => s.openAutomation);
  const exec = useStore((s) => s.exec);
  const raveAvailable = useStore((s) => s.snapshot?.session?.raveAvailable ?? false);
  const plugins = (track?.plugins ?? []).filter((p) => p.external || p.builtin || p.rave);
  // The "+ Plugin" target is injectable: the classic shell opens the modal browser
  // (store.openBrowser); the v2 shell routes it to its left browser dock instead so the
  // plugin picker lives on ONE surface. Default preserves the classic modal behavior.
  const addPlugin = onAddPlugin ?? openBrowser;
  return (
    <div className="rack" data-testid="rack">
      <div className="rack-label">
        {track ? <>CHAIN · <b>{track.name}</b></> : "select a track to add effects"}
      </div>
      <div className="rack-chain">
        {track && plugins.map((p) => <PluginCard key={p.index} plugin={p} trackId={track.id} />)}
        {track && plugins.length === 0 && <span className="rack-empty">No effects yet — add a plugin.</span>}
        {track && <button className="btn rack-add" onClick={addPlugin}>+ Plugin</button>}
        {/* Route C.2 — only offered where the anira build can host a real-time RAVE model. */}
        {track && raveAvailable && <button className="btn rack-add" data-testid="rack-add-rave" onClick={() => void exec("add_rave_insert", { trackId: track.id })}>+ RAVE</button>}
        {track && <button className="btn rack-add" data-testid="open-automation" title="Parameter automation" aria-label="Open parameter automation" onClick={() => openAutomation(track.id)}>⌁ Automation</button>}
      </div>
    </div>
  );
}

function PluginCard({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const isBuiltin = !!plugin.builtin;
  const isRave = !!plugin.rave;
  return (
    <div
      className={`pcard${plugin.enabled ? "" : " bypassed"}${isRave ? " neural" : ""}`}
      data-testid="plugin-card" data-plugin-index={plugin.index} data-enabled={plugin.enabled}
      /* CAP-EFX-003 — drag a card to reorder the chain. All four reference DAWs drag
         inserts, so drag is the 2-of-4 idiom; the ‹/› buttons stay because a drag is not
         keyboard-reachable and removing them would trade one accessibility gap for
         another. Signal-chain ORDER is audible (an EQ before a compressor is a different
         sound), which is why this is worth a gesture rather than two clicks per hop. */
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(plugin.index));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (!Number.isFinite(from) || from === plugin.index) return;   // a drop on itself is a no-op, not an error
        void exec("reorder_plugin", { trackId, index: from, toIndex: plugin.index });
      }}>
      <div className="pcard-head">
        <button className={`pdot${plugin.enabled ? " on" : ""}`} title={plugin.enabled ? "Bypass" : "Enable"}
          aria-pressed={!plugin.enabled}
          onClick={() => void exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })} />
        <span className="pname">{isRave ? `RAVE · ${plugin.rave!.model}` : plugin.name}</span>
        {plugin.isInstrument && <span className="ibadge">inst</span>}
        {plugin.isInstrument && <PresetPicker plugin={plugin} trackId={trackId} />}
        {isRave && <span className="ibadge nbadge">RAVE</span>}
        {isBuiltin && !plugin.isInstrument && <span className="ibadge">{plugin.category}</span>}
      </div>
      {isRave ? <RaveBody plugin={plugin} trackId={trackId} />
        : isBuiltin ? <ParamBody plugin={plugin} trackId={trackId} />
        : (
          <div className="pcard-actions">
            <button className="btn" onClick={() => void exec("open_plugin_editor", { trackId, index: plugin.index })}>Edit</button>
            <button className="btn" title="Move left" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })}>‹</button>
            <button className="btn" title="Move right" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })}>›</button>
            <button className="btn x" onClick={() => void exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
          </div>
        )}
    </div>
  );
}

// P1 preset seam — the mouse path onto list_presets/load_preset (same seam the agent
// uses). Shown only on instrument cards with a loadable preset format today: the
// built-in 4OSC ('4osc' bank, .json patches) and a hosted Vital ('vital', .vital
// patches). Other instruments (e.g. Serum) have no loadable preset format yet, so no
// picker rather than a picker that can't work. Selecting an option fires load_preset
// (one undo step) and resets the select so the same preset can be re-applied.
function PresetPicker({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const [presets, setPresets] = useState<{ name: string; file: string }[] | null>(null);
  const key = plugin.builtin
    ? (plugin.type === "4osc" ? "4osc" : null)
    : /vital/i.test(plugin.name) ? "vital" : null;
  useEffect(() => {
    if (!key) return;
    let dead = false;
    void exec("list_presets", { plugin: key }).then((r) => {
      if (dead || !r.ok) return;
      setPresets((r.data as { presets?: { name: string; file: string }[] } | undefined)?.presets ?? []);
    });
    return () => { dead = true; };
  }, [exec, key]);
  if (!key || !presets || presets.length === 0) return null;
  return (
    <select className="preset-pick" data-testid="preset-pick" value=""
      title="Load a preset" aria-label={`Load a preset onto ${plugin.name}`}
      onChange={(e) => {
        const file = e.target.value;
        if (file) void exec("load_preset", { trackId, index: plugin.index, file });
      }}>
      <option value="" disabled>Presets…</option>
      {presets.map((p) => <option key={p.file} value={p.file}>{p.name}</option>)}
    </select>
  );
}

// Route C.2 / Lane B — the real-time RAVE insert's rack card: a model BROWSER (drop a .ts into
// RAVE_MODEL_DIR / ~/AI/rave-models → it lists), dry/wet, latency. Mirrors the LoRA-rack pattern:
// a dropdown of installed models (list_rave_models) plus a "custom path…" escape hatch.
function RaveBody({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const models = useStore((s) => s.availableRaveModels);
  const loadRaveModels = useStore((s) => s.loadRaveModels);
  const r = plugin.rave!;
  useEffect(() => { loadRaveModels(); }, [loadRaveModels]);
  const loadCustom = () => {
    const v = window.prompt("RAVE model — a .ts path (or a name in RAVE_MODEL_DIR):", r.modelPath ?? "")?.trim();
    if (!v) return;
    void exec("load_rave_model", v.endsWith(".ts")
      ? { trackId, pluginIndex: plugin.index, path: v }
      : { trackId, pluginIndex: plugin.index, target: v });
  };
  return (
    <div className="pbody">
      <div className="neural-model tc" title={r.modelPath ?? r.modelName} data-testid="rave-model-name">
        {r.modelLoaded ? (r.modelName || r.model) : "no model loaded"}
      </div>
      <div className="neural-row">
        <select className="btn ghost" data-testid="rave-model-select" value=""
          title="Pick a RAVE model from the library"
          onChange={(e) => e.target.value && void exec("load_rave_model", { trackId, pluginIndex: plugin.index, target: e.target.value })}>
          <option value="">{models.length ? "load model…" : "no models found"}</option>
          {models.map((m) => <option key={m.name} value={m.name}>{m.name}{m.sizeMB ? ` (${m.sizeMB} MB)` : ""}</option>)}
        </select>
        <button className="btn ghost" data-testid="rave-load-custom" title="Load a .ts by path" onClick={loadCustom}>path…</button>
      </div>
      <label className="nparam">
        <span className="nlabel">mix</span>
        <span className="nslider"><input type="range" min={0} max={100} step={1} value={Math.round(r.mix)}
          data-testid="rave-mix"
          onChange={(e) => void exec("set_rave_param", { trackId, index: plugin.index, paramId: "mix", value: Number(e.target.value) })} /></span>
        <span className="nval">{Math.round(r.mix)}</span>
      </label>
      <div className="neural-row">
        <button className="btn" onClick={() => void exec("reset_rave", { trackId, index: plugin.index })}>Reset</button>
        <span className="nlat tc">{(r.latencySeconds * 1000).toFixed(1)} ms</span>
        <button className="btn x" onClick={() => void exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
    </div>
  );
}

function ParamBody({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const params = (plugin.params ?? []).slice(0, 8);
  return (
    <div className="pbody">
      {params.map((p) => (
        <label key={p.index} className="nparam">
          <span className="nlabel" title={p.name}>{p.name}</span>
          <input type="range" min={0} max={1} step={0.01} value={p.value}
            onChange={(e) => void exec("set_plugin_param", { trackId, index: plugin.index, paramIndex: p.index, value: Number(e.target.value) })} />
          <span className="nval">{Math.round(p.value * 100)}</span>
        </label>
      ))}
      {params.length === 0 && <span className="rack-empty">no params</span>}
      {plugin.moshFx?.kind === "feedback" && <XFeedbackReadout plugin={plugin} />}
      <div className="neural-row">
        <button className="btn" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })}>‹</button>
        <button className="btn" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })}>›</button>
        <button className="btn x" onClick={() => void exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
    </div>
  );
}

function XFeedbackReadout({ plugin }: { plugin: Plugin }) {
  const candidates = plugin.moshFx?.candidates ?? [];
  const activeCuts = plugin.moshFx?.activeCuts ?? [];
  return (
    <>
      <span className="rack-empty">candidates</span>
      {candidates.slice(0, 3).map((c) => (
        <div key={`${c.frequencyHz}-${c.depthDb ?? 0}`} className="nparam">
          <span className="nlabel">{Math.round(c.frequencyHz)} Hz</span>
          <span className="nval">{Math.round((c.score ?? 0) * 100)}</span>
          <span className="rack-empty">{(c.depthDb ?? 0).toFixed(1)} dB</span>
        </div>
      ))}
      <div className="nparam">
        <span className="nlabel">active cuts</span>
        <span className="rack-empty">
          {activeCuts.length === 0 ? "none" : activeCuts.map((c) => `${Math.round(c.frequencyHz)} Hz ${(c.depthDb ?? 0).toFixed(1)} dB`).join(", ")}
        </span>
      </div>
    </>
  );
}
