// Bottom dock for the selected track: the plugin/neural RACK (Stage 3/4) on the
// left and the generative DRAWER (Stage 5) on the right. Ported from the legacy
// Rack/GenPanel into the ink+lime register — same command seam, same arg shapes.

import { useEffect } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import type { Snapshot, Plugin, Track, Clip, RenderColor } from "../types";
import { Moshi } from "./Moshi";

export function Dock({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? null;
  // In the redesign, Moshi is a participant in the Session rail, not in the dock.
  const redesign = useSettings((s) => Boolean(s.get("redesignShell")));
  return (
    <div className="dock" data-testid="dock">
      <Rack track={track} />
      {track && <GenDrawer track={track} />}
      {!redesign && <Moshi />}
    </div>
  );
}

function Rack({ track }: { track: Track | null }) {
  const openBrowser = useStore((s) => s.openBrowser);
  const openAutomation = useStore((s) => s.openAutomation);
  const exec = useStore((s) => s.exec);
  const raveAvailable = useStore((s) => s.snapshot?.session?.raveAvailable ?? false);
  const plugins = (track?.plugins ?? []).filter((p) => p.external || p.builtin || p.rave);
  return (
    <div className="rack" data-testid="rack">
      <div className="rack-label">
        {track ? <>CHAIN · <b>{track.name}</b></> : "select a track to add effects"}
      </div>
      <div className="rack-chain">
        {track && plugins.map((p) => <PluginCard key={p.index} plugin={p} trackId={track.id} />)}
        {track && plugins.length === 0 && <span className="rack-empty">No effects yet — add a plugin.</span>}
        {track && <button className="btn rack-add" onClick={openBrowser}>+ Plugin</button>}
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
    <div className={`pcard${plugin.enabled ? "" : " bypassed"}${isRave ? " neural" : ""}`} data-testid="plugin-card" data-plugin-index={plugin.index} data-enabled={plugin.enabled}>
      <div className="pcard-head">
        <button className={`pdot${plugin.enabled ? " on" : ""}`} title={plugin.enabled ? "Bypass" : "Enable"}
          aria-pressed={!plugin.enabled}
          onClick={() => void exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })} />
        <span className="pname">{isRave ? `RAVE · ${plugin.rave!.model}` : plugin.name}</span>
        {plugin.isInstrument && <span className="ibadge">inst</span>}
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

// Route C.2 — the real-time RAVE insert's rack card: model name + dry/wet + latency.
function RaveBody({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const r = plugin.rave!;
  const loadModel = () => {
    const v = window.prompt("RAVE model — a .ts path, or a target name in RAVE_MODEL_DIR:", r.modelPath ?? "")?.trim();
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
      <label className="nparam">
        <span className="nlabel">mix</span>
        <span className="nslider"><input type="range" min={0} max={100} step={1} value={Math.round(r.mix)}
          data-testid="rave-mix"
          onChange={(e) => void exec("set_rave_param", { trackId, index: plugin.index, paramId: "mix", value: Number(e.target.value) })} /></span>
        <span className="nval">{Math.round(r.mix)}</span>
      </label>
      <div className="neural-row">
        <button className="btn" data-testid="rave-load-model" title="Load a RAVE .ts model" onClick={loadModel}>Load model…</button>
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
      <div className="neural-row">
        <button className="btn" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index - 1 })}>‹</button>
        <button className="btn" onClick={() => void exec("reorder_plugin", { trackId, index: plugin.index, toIndex: plugin.index + 1 })}>›</button>
        <button className="btn x" onClick={() => void exec("remove_plugin", { trackId, index: plugin.index })}>✕</button>
      </div>
    </div>
  );
}

export function GenDrawer({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const colorsAvail = useStore((s) => s.availableColors);
  const loadColors = useStore((s) => s.loadColors);
  const loadTransformTargets = useStore((s) => s.loadTransformTargets);
  const qaByClip = useStore((s) => s.qaByClip);
  useEffect(() => { loadColors(); loadTransformTargets(); }, [loadColors, loadTransformTargets]);

  const clip = track.clips.find((c) => c.type === "wave");
  if (!clip) return <div className="gen" data-testid="generative"><div className="gen-head"><span className="gen-title">⃝ GENERATIVE</span></div><span className="rack-empty">Add or import an audio clip on this track to re-imagine or transform it.</span></div>;
  const rl = clip.renderLayer;
  const sa3 = colorsAvail.length > 0;

  return (
    <div className="gen" data-testid="generative">
      <div className="gen-head"><span className="gen-title">⃝ GENERATIVE</span><span className="gen-clip">{rl?.mode === "transform" ? "transform" : sa3 ? "stable audio 3" : "fake"} · {clip.name}</span></div>
      {!rl ? (
        <div className="gen-create-row">
          <button className="btn rack-add" data-testid="gen-create"
            onClick={() => void exec("create_render_layer", { clipId: clip.id, adapter: sa3 ? "stable_audio3" : "fake", mode: "reimagine", modelVariant: sa3 ? "sa3-medium" : "" })}>+ Re-imagine</button>
          <button className="btn rack-add" data-testid="gen-create-transform"
            onClick={() => void exec("create_render_layer", { clipId: clip.id, adapter: "transform", mode: "transform" })}>+ Transform</button>
        </div>
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
  const bumpCelebrate = useStore((s) => s.bumpCelebrate);
  const progress = useStore((s) => s.renderProgress[clip.id]);
  const rl = clip.renderLayer!;
  const active: RenderColor[] = rl.colors ?? [];
  const rendering = rl.status === "rendering" || rl.status === "queued";
  const setColors = (next: RenderColor[]) => exec("set_render_param", { clipId: clip.id, colors: next.slice(0, 3), lab: labMode });
  const blockedBy = (name: string) => (colorsAvail.find((c) => c.name === name)?.no_stack_with ?? []).some((n) => active.some((a) => a.name === n));
  const addable = colorsAvail.filter((c) => !active.some((a) => a.name === c.name) && !blockedBy(c.name));
  const isTransform = rl.mode === "transform";

  return (
    <div className="gen-body" data-render-status={rl.status}>
      {isTransform ? <TransformControls clip={clip} /> : (<>
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
      </>)}
      <div className="gen-status" role="status" aria-live="polite">
        <span className={`gen-badge st-${rl.status}`} data-testid="render-status">{rl.status}</span>
        <span className="gen-seed tc">seed {rl.seed}</span>
        <button className={`btn${labMode ? " on" : ""}`} title="Lab — unlock the ASTD clamp" aria-pressed={labMode} onClick={() => setLab(!labMode)}>{labMode ? "⚠ LAB" : "Lab"}</button>
      </div>
      {rendering && (
        <div className="gen-prog" role="progressbar" aria-label="Render progress"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
          <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
        </div>
      )}
      {qa && qa.pq != null && (
        <div className="gen-qa tc" title="judge-panel production quality">
          pq {qa.pq}{qa.pq_base != null ? ` / ${qa.pq_base}` : ""}
          {qa.flags?.map((f) => <span key={f} className={`qa-flag${f === "quality_degraded" ? " warn" : ""}`}>{f}</span>)}
        </div>
      )}
      <div className="gen-actions">
        <button className="btn" data-testid="gen-render" onClick={() => void exec("render_layer", { clipId: clip.id })}>{rl.hasArtifact ? "Re-render" : "Render"}</button>
        {rendering && <button className="btn" onClick={() => void exec("cancel_render", { clipId: clip.id })}>Cancel</button>}
        <button className="btn" disabled={!rl.hasArtifact} data-testid="gen-accept" onClick={async () => { const r = await exec("accept_render", { clipId: clip.id }); if (r.ok) bumpCelebrate(); }}>Accept</button>
        <button className="btn" disabled={!rl.hasArtifact} onClick={() => void exec("reject_render", { clipId: clip.id })}>Reject</button>
        <button className="btn" title="new take" onClick={() => void exec("set_render_param", { clipId: clip.id, seed: Number(rl.seed) + 1 })}>⟳ seed</button>
        <button className="btn x" title="remove layer" onClick={() => void exec("remove_render_layer", { clipId: clip.id })}>✕</button>
      </div>
    </div>
  );
}

// Route B — the transform control surface (model-agnostic): a target instrument
// picker + a free-text override (when the tier allows it) + a strength slider. Writes
// through the same set_render_param command the colours UI uses.
function TransformControls({ clip }: { clip: Clip }) {
  const exec = useStore((s) => s.exec);
  const targets = useStore((s) => s.availableTransformTargets);
  const freeText = useStore((s) => s.transformFreeText);
  const rl = clip.renderLayer!;
  const target = rl.target ?? "";
  const strength = rl.strength ?? 65;
  const known = targets.some((t) => t.name === target);
  const setTarget = (t: string) => void exec("set_render_param", { clipId: clip.id, target: t });
  return (
    <div className="xform-controls">
      <label className="nparam">
        <span className="nlabel">target</span>
        <select className="btn ghost" data-testid="xform-target" value={known ? target : ""}
          onChange={(e) => e.target.value && setTarget(e.target.value)}>
          <option value="">{target && !known ? `(${target})` : "pick instrument…"}</option>
          {targets.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
      </label>
      {freeText && (
        <label className="nparam">
          <span className="nlabel">or text</span>
          <input className="xform-text" type="text" data-testid="xform-text" placeholder="e.g. lush orchestra"
            defaultValue={known ? "" : target}
            onBlur={(e) => setTarget(e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === "Enter") setTarget((e.target as HTMLInputElement).value.trim()); }} />
        </label>
      )}
      <label className="nparam">
        <span className="nlabel">strength</span>
        <span className="nslider"><input type="range" min={0} max={100} step={1} value={Math.round(strength)}
          data-testid="xform-strength"
          onChange={(e) => void exec("set_render_param", { clipId: clip.id, strength: Number(e.target.value) })} /></span>
        <span className="nval">{Math.round(strength)}</span>
      </label>
    </div>
  );
}
