// Bottom dock for the selected track: the plugin/neural RACK (Stage 3/4) on the
// left and the generative DRAWER (Stage 5) on the right. Ported from the legacy
// Rack/GenPanel into the ink+lime register — same command seam, same arg shapes.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import type { Snapshot, Plugin, Track, Clip, RenderColor, RenderQA } from "../types";
import { Moshi } from "./Moshi";
import { qaReadoutView } from "./qaReadout";
import { pickGenClip } from "./genClip";

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

export function GenDrawer({ track, selectedClipId }: { track: Track; selectedClipId?: string }) {
  const exec = useStore((s) => s.exec);
  const colorsAvail = useStore((s) => s.availableColors);
  const loadColors = useStore((s) => s.loadColors);
  const loadTransformTargets = useStore((s) => s.loadTransformTargets);
  const qaByClip = useStore((s) => s.qaByClip);
  useEffect(() => { loadColors(); loadTransformTargets(); }, [loadColors, loadTransformTargets]);

  // Generative runs on ANY clip type — a MIDI/drum clip is auto-bounced to audio by the
  // backend before the model. Target the SELECTED clip when it's on this track, else the
  // track's first clip; the empty-state shows only when the track has no clips at all.
  const clip = pickGenClip(track, selectedClipId);
  if (!clip) return <div className="gen" data-testid="generative"><div className="gen-head"><span className="gen-title">⃝ GENERATIVE</span></div><span className="rack-empty">Add a clip on this track to re-imagine or transform it.</span></div>;
  const rl = clip.renderLayer;
  const sa3 = colorsAvail.length > 0;

  return (
    <div className="gen" data-testid="generative">
      <div className="gen-head"><span className="gen-title">⃝ GENERATIVE</span><span className="gen-clip">{rl?.mode === "sing" ? "sing" : rl?.mode === "transform" ? "transform" : sa3 ? "stable audio 3" : "fake"} · {clip.name}</span></div>
      {!rl ? (
        <>
          <CompileBox clipId={clip.id} trackId={track.id} />
          <div className="gen-create-row">
            <button className="btn rack-add" data-testid="gen-create"
              onClick={() => void exec("create_render_layer", { clipId: clip.id, adapter: sa3 ? "stable_audio3" : "fake", mode: "reimagine", modelVariant: sa3 ? "sa3-medium" : "" })}>+ Re-imagine</button>
            <button className="btn rack-add" data-testid="gen-create-transform"
              onClick={() => void exec("create_render_layer", { clipId: clip.id, adapter: "transform", mode: "transform" })}>+ Transform</button>
            {track.lyricSheet && (
              <button className="btn rack-add" data-testid="gen-create-sing"
                onClick={() => void exec("create_render_layer", { clipId: clip.id, adapter: "soulx", mode: "sing" })}>+ Sing</button>
            )}
          </div>
        </>
      ) : (
        <GenBody clip={clip} track={track} qa={qaByClip[clip.id]} />
      )}
    </div>
  );
}

// "Describe it…" — the prompt compiler entry point. The producer types a loose
// instruction; compile_render classifies it and either (a) fills a validated re-imagine/
// transform layer, so the chosen colours/target appear in the rack below (transparency),
// (b) names the CORRECTIVE tool that actually fixes the take — AutoTune/EQ/OTT/quantize —
// offered as a one-click action (it corrects, it doesn't re-perform), or (c) honestly
// declines a vocal/noise request. Uses wait:true (the compile is a fast, explicit lookup)
// so the verdict — including the corrective tool + say — comes straight back.
const TOOL_LABEL: Record<string, string> = {
  moshAutoTune: "Add AutoTune", eq: "Add EQ", moshOTT: "Add OTT", quantize_notes: "Quantize notes",
};

function CompileBox({ clipId, trackId }: { clipId: string; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState<string | null>(null);
  const [fixTool, setFixTool] = useState<string | null>(null);
  const reset = () => { setSay(null); setFixTool(null); };
  const submit = async () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    setBusy(true); reset();
    const r = await exec("compile_render", { clipId, instruction, wait: true });
    setBusy(false);
    const data = (r?.data ?? {}) as { mode?: string; say?: string; tool?: string | null };
    if (data.mode === "corrective") { setSay(data.say ?? null); setFixTool(data.tool ?? null); }
    else if (data.mode === "unsupported") setSay(data.say ?? "I can't do that with the generative model.");
    else setText("");   // re-imagine / transform applied — the rack now shows what it chose
  };
  const applyFix = async () => {
    if (!fixTool) return;
    if (fixTool === "quantize_notes") await exec("quantize_notes", { clipId });
    else await exec("load_builtin", { trackId, type: fixTool });
    setText(""); reset();
  };
  return (
    <div className="gen-compile" data-testid="gen-compile">
      <div className="gen-compile-row">
        <input className="gen-compile-input" data-testid="gen-compile-input" type="text"
          placeholder="describe it… e.g. make it lo-fi, or “as a violin”" value={text} disabled={busy}
          aria-label="Describe the generative edit"
          onChange={(e) => { setText(e.target.value); reset(); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        <button className="btn rack-add" data-testid="gen-compile-go" disabled={busy || !text.trim()}
          onClick={() => void submit()}>{busy ? "…" : "✨ Compile"}</button>
      </div>
      {say && <div className="gen-compile-say" role="status" data-testid="gen-compile-say">{say}</div>}
      {fixTool && (
        <button className="btn rack-add gen-compile-fix" data-testid="gen-compile-fix"
          onClick={() => void applyFix()}>{TOOL_LABEL[fixTool] ?? "Apply fix"}</button>
      )}
    </div>
  );
}

function GenBody({ clip, track, qa }: { clip: Clip; track: Track; qa?: RenderQA }) {
  const qaView = qaReadoutView(qa);
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
  const isSing = rl.mode === "sing";

  return (
    <div className="gen-body" data-render-status={rl.status}>
      {isSing ? <SingControls track={track} /> : isTransform ? <TransformControls clip={clip} /> : (<>
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
        {rl.status === "error" && rl.error && (
          <span className="gen-error" data-testid="render-error" title={rl.error}>{rl.error}</span>
        )}
        {/* seed + coverage are no-ops for soulx (supports_seed:false, coverage unread) but both
            sit in the fingerprint — showing them for sing invites a pointless full re-render
            (real backend: a ~900s SSH round-trip) for zero output change. */}
        {!isSing && <span className="gen-seed tc">seed {rl.seed}</span>}
        {!isSing && (
        <select className="gen-cov" data-testid="gen-coverage"
          title="Whole-clip coverage — auto, loop (tile one cycle, in time), or stitch (window + crossfade the whole clip)"
          value={rl.coverage ?? "auto"} onChange={(e) => void exec("set_render_param", { clipId: clip.id, coverage: e.target.value })}>
          <option value="auto">auto</option>
          <option value="loop">loop</option>
          <option value="stitch">stitch</option>
        </select>
        )}
        <button className={`btn${labMode ? " on" : ""}`} title="Lab — unlock the ASTD clamp" aria-pressed={labMode} onClick={() => setLab(!labMode)}>{labMode ? "⚠ LAB" : "Lab"}</button>
      </div>
      {rendering && (
        <div className="gen-prog" role="progressbar" aria-label="Render progress"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
          <span style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
        </div>
      )}
      {qaView && (
        <div className="gen-qa tc" title="judge-panel production quality">
          <div className="gen-qa-line">
            {qaView.pqText}
            {qaView.flags.map((f) => <span key={f.label} className={`qa-flag${f.warn ? " warn" : ""}`}>{f.label}</span>)}
          </div>
          {qaView.reasoning && (
            <div className="gen-qa-reasoning" data-testid="qa-reasoning">{qaView.reasoning}</div>
          )}
        </div>
      )}
      <div className="gen-actions">
        {isSing ? (
          // Sing keeps the legacy auditionable flow (mirrors the C++ finalizeRender gate): the
          // guide vocal never replaces the recorded take in place — render, listen, then Accept
          // lands it (or Reject drops it).
          <>
            <button className="btn" data-testid="gen-render" onClick={() => void exec("render_layer", { clipId: clip.id })}>{rl.hasArtifact ? "Re-render" : "Render"}</button>
            <button className="btn" disabled={!rl.hasArtifact} data-testid="gen-accept" onClick={async () => { const r = await exec("accept_render", { clipId: clip.id }); if (r.ok) bumpCelebrate(); }}>Accept</button>
            <button className="btn" disabled={!rl.hasArtifact} onClick={() => void exec("reject_render", { clipId: clip.id })}>Reject</button>
          </>
        ) : clip.type === "wave" ? (
          // Wave clips auto-apply in place — the waveform swaps to the result instantly.
          // No accept/reject; Reset restores the original.
          <>
            <button className="btn" data-testid="gen-render" onClick={() => void exec("render_layer", { clipId: clip.id })}>Re-imagine</button>
            <button className="btn" data-testid="gen-reset" disabled={!rl.hasOriginal} title="Restore the original audio" onClick={() => void exec("reset_render_layer", { clipId: clip.id })}>Reset</button>
          </>
        ) : (
          // MIDI/drum: the render lands as HIDDEN audio beneath the muted MIDI (Phase 2) — instant,
          // and the MIDI stays editable underneath. No accept step; Reset un-mutes the MIDI and drops
          // the hidden audio.
          <>
            <button className="btn" data-testid="gen-render" onClick={() => { void exec("render_layer", { clipId: clip.id }); if (!rl.reimagineActive) bumpCelebrate(); }}>Re-imagine</button>
            <button className="btn" data-testid="gen-reset" disabled={!rl.reimagineActive} title="Un-mute the MIDI and drop the hidden re-imagined audio" onClick={() => void exec("reset_render_layer", { clipId: clip.id })}>Reset</button>
          </>
        )}
        {rendering && <button className="btn" onClick={() => void exec("cancel_render", { clipId: clip.id })}>Cancel</button>}
        {!isSing && <button className="btn" title="new take" onClick={() => void exec("set_render_param", { clipId: clip.id, seed: Number(rl.seed) + 1 })}>⟳ seed</button>}
        <button className="btn x" title="remove layer" onClick={() => void exec("remove_render_layer", { clipId: clip.id })}>✕</button>
      </div>
    </div>
  );
}

// FMS Phase-3 — the sing control surface: renders the track's lyric sheet in the
// producer's own voice (fake legato-beep guide until the real backend is enrolled +
// configured). Read-only status here — the sheet is edited in the Lyrics tab; render/
// accept/seed ride the shared chrome below.
function SingControls({ track }: { track: Track }) {
  const voiceEnrolled = useStore((s) => s.snapshot?.session?.singVoiceEnrolled ?? false);
  const lines = track.lyricSheet?.lines ?? [];
  const flowed = lines.filter((l) => l.hasScore).length;
  return (
    <div className="sing-controls">
      <label className="nparam">
        <span className="nlabel">flow</span>
        <span className="tc" data-testid="sing-flow">{flowed}/{lines.length} lines carry your take's flow</span>
      </label>
      <label className="nparam">
        <span className="nlabel">voice</span>
        <span className="tc" data-testid="sing-voice">
          {voiceEnrolled ? "enrolled — locked to your voice only" : "not enrolled — renders a guide melody (beeps)"}
        </span>
      </label>
      {flowed === 0 && (
        <span className="rack-empty">No flow yet — use “Build flow from this take” on the vocal clip first.</span>
      )}
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
