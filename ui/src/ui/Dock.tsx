// Bottom dock for the selected track: the plugin/neural RACK (Stage 3/4) on the
// left and the generative DRAWER (Stage 5) on the right. Ported from the legacy
// Rack/GenPanel into the ink+lime register — same command seam, same arg shapes.

import { useEffect } from "react";
import { useStore } from "../store";
import type { Snapshot, Plugin, Track, Clip, RenderColor } from "../types";

export function Dock({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? null;
  return (
    <div className="dock" data-testid="dock">
      <Rack track={track} />
      {track && <GenDrawer track={track} />}
    </div>
  );
}

function Rack({ track }: { track: Track | null }) {
  const openBrowser = useStore((s) => s.openBrowser);
  const exec = useStore((s) => s.exec);
  const plugins = (track?.plugins ?? []).filter((p) => p.external || p.neural || p.builtin);
  return (
    <div className="rack" data-testid="rack">
      <div className="rack-label">{track ? <>CHAIN · <b>{track.name}</b></> : "select a track"}</div>
      <div className="rack-chain">
        {track && plugins.map((p) => <PluginCard key={p.index} plugin={p} trackId={track.id} />)}
        {track && plugins.length === 0 && <span className="rack-empty">no plugins</span>}
        {track && <button className="btn rack-add" onClick={openBrowser}>+ Plugin</button>}
        {track && <button className="btn rack-add" onClick={() => void exec("add_neural_insert", { trackId: track.id, modelId: "nam" })}>+ Neural</button>}
      </div>
    </div>
  );
}

function PluginCard({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const isNeural = !!plugin.neural, isBuiltin = !!plugin.builtin;
  return (
    <div className={`pcard${plugin.enabled ? "" : " bypassed"}${isNeural ? " neural" : ""}`} data-testid="plugin-card" data-plugin-index={plugin.index} data-enabled={plugin.enabled}>
      <div className="pcard-head">
        <button className={`pdot${plugin.enabled ? " on" : ""}`} title={plugin.enabled ? "Bypass" : "Enable"}
          aria-pressed={!plugin.enabled}
          onClick={() => void exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })} />
        <span className="pname">{isNeural ? `Neural · ${plugin.neural!.model}` : plugin.name}</span>
        {plugin.isInstrument && <span className="ibadge">inst</span>}
        {isNeural && <span className="ibadge nbadge">Tier A</span>}
        {isBuiltin && !plugin.isInstrument && <span className="ibadge">{plugin.category}</span>}
      </div>
      {isNeural ? <NeuralBody plugin={plugin} trackId={trackId} />
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
      <div className="neural-row">
        <button className="btn" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })}>‹</button>
        <button className="btn" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })}>›</button>
        <button className="btn x" onClick={() => void exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
    </div>
  );
}

function NeuralBody({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const n = plugin.neural!;
  return (
    <div className="pbody">
      {n.params.map((p) => (
        <label key={p.id} className="nparam">
          <span className="nlabel">{p.id}</span>
          <span className="nslider">
            <input type="range" min={0} max={100} step={1} value={Math.round(p.ui)}
              onChange={(e) => void exec("set_neural_param", { trackId, index: plugin.index, paramId: p.id, value: Number(e.target.value) })} />
            {!n.labMode && p.safeMaxUi < 100 && <span className="astd-mark" style={{ left: `${p.safeMaxUi}%` }} title="ASTD safe limit" />}
          </span>
          <span className="nval">{Math.round(p.ui)}</span>
        </label>
      ))}
      <div className="neural-row">
        <button className={`btn${n.labMode ? " on" : ""}`} title="Lab mode — unlock past the ASTD clamp" aria-pressed={n.labMode}
          onClick={() => void exec("set_neural_lab_mode", { trackId, index: plugin.index, on: !n.labMode })}>{n.labMode ? "⚠ LAB" : "Lab"}</button>
        <button className="btn" onClick={() => void exec("reset_neural", { trackId, index: plugin.index })}>Reset</button>
        <span className="nlat tc">{(n.latencySeconds * 1000).toFixed(1)} ms</span>
        <button className="btn x" onClick={() => void exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
    </div>
  );
}

function GenDrawer({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const colorsAvail = useStore((s) => s.availableColors);
  const loadColors = useStore((s) => s.loadColors);
  const qaByClip = useStore((s) => s.qaByClip);
  useEffect(() => { loadColors(); }, [loadColors]);

  const clip = track.clips.find((c) => c.type === "wave");
  if (!clip) return <div className="gen" data-testid="generative"><div className="gen-head"><span className="gen-title">⃝ GENERATIVE</span></div><span className="rack-empty">no wave clip</span></div>;
  const rl = clip.renderLayer;
  const sa3 = colorsAvail.length > 0;

  return (
    <div className="gen" data-testid="generative">
      <div className="gen-head"><span className="gen-title">⃝ GENERATIVE</span><span className="gen-clip">{sa3 ? "stable audio 3" : "fake"} · {clip.name}</span></div>
      {!rl ? (
        <button className="btn rack-add" data-testid="gen-create"
          onClick={() => void exec("create_render_layer", { clipId: clip.id, adapter: sa3 ? "stable_audio3" : "fake", mode: "reimagine", modelVariant: sa3 ? "sa3-medium" : "" })}>+ Render layer</button>
      ) : (
        <GenBody clip={clip} qa={qaByClip[clip.id]} />
      )}
    </div>
  );
}

function GenBody({ clip, qa }: { clip: Clip; qa?: { pq?: number | null; pq_base?: number | null; flags?: string[] } }) {
  const exec = useStore((s) => s.exec);
  const colorsAvail = useStore((s) => s.availableColors);
  const labMode = useStore((s) => s.labMode);
  const setLab = useStore((s) => s.setLab);
  const rl = clip.renderLayer!;
  const active: RenderColor[] = rl.colors ?? [];
  const rendering = rl.status === "rendering" || rl.status === "queued";
  const setColors = (next: RenderColor[]) => exec("set_render_param", { clipId: clip.id, colors: next.slice(0, 3), lab: labMode });
  const blockedBy = (name: string) => (colorsAvail.find((c) => c.name === name)?.no_stack_with ?? []).some((n) => active.some((a) => a.name === n));
  const addable = colorsAvail.filter((c) => !active.some((a) => a.name === c.name) && !blockedBy(c.name));

  return (
    <div className="gen-body" data-render-status={rl.status}>
      {active.map((c) => {
        const meta = colorsAvail.find((m) => m.name === c.name);
        return (
          <label key={c.name} className="nparam">
            <span className="nlabel">{c.name}{meta && meta.astd_max <= 0.1 && <span className="cap-tag">CAPPED</span>}</span>
            <input type="range" min={0} max={100} step={1} value={Math.round(c.value)}
              onChange={(e) => setColors(active.map((a) => (a.name === c.name ? { ...a, value: Number(e.target.value) } : a)))} />
            <button className="btn x" onClick={() => setColors(active.filter((a) => a.name !== c.name))}>✕</button>
          </label>
        );
      })}
      {active.length < 3 && addable.length > 0 && (
        <select className="btn ghost color-add" value="" onChange={(e) => e.target.value && setColors([...active, { name: e.target.value, value: 65 }])}>
          <option value="">+ colour…</option>
          {addable.map((c) => <option key={c.name} value={c.name}>{c.name}{c.verdict === "WEAK" ? " (weak)" : ""}</option>)}
        </select>
      )}
      <div className="gen-status">
        <span className={`gen-badge st-${rl.status}`} data-testid="render-status">{rl.status}</span>
        <span className="gen-seed tc">seed {rl.seed}</span>
        <button className={`btn${labMode ? " on" : ""}`} title="Lab — unlock the ASTD clamp" aria-pressed={labMode} onClick={() => setLab(!labMode)}>{labMode ? "⚠ LAB" : "Lab"}</button>
      </div>
      {qa && qa.pq != null && (
        <div className="gen-qa tc" title="judge-panel production quality">
          pq {qa.pq}{qa.pq_base != null ? ` / ${qa.pq_base}` : ""}
          {qa.flags?.map((f) => <span key={f} className={`qa-flag${f === "quality_degraded" ? " warn" : ""}`}>{f}</span>)}
        </div>
      )}
      <div className="gen-actions">
        <button className="btn" data-testid="gen-render" onClick={() => void exec("render_layer", { clipId: clip.id })}>{rl.hasArtifact ? "Re-render" : "Render"}</button>
        {rendering && <button className="btn" onClick={() => void exec("cancel_render", { clipId: clip.id })}>Cancel</button>}
        <button className="btn" disabled={!rl.hasArtifact} data-testid="gen-accept" onClick={() => void exec("accept_render", { clipId: clip.id })}>Accept</button>
        <button className="btn" disabled={!rl.hasArtifact} onClick={() => void exec("reject_render", { clipId: clip.id })}>Reject</button>
        <button className="btn" title="new take" onClick={() => void exec("set_render_param", { clipId: clip.id, seed: Number(rl.seed) + 1 })}>⟳ seed</button>
        <button className="btn x" title="remove layer" onClick={() => void exec("remove_render_layer", { clipId: clip.id })}>✕</button>
      </div>
    </div>
  );
}
