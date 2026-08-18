// The generative DRAWER (Stage 5) for the selected track. Extracted verbatim from
// Dock.tsx so both shells (classic Dock/Inspector, v2 Inspector) import it without
// pulling in the classic-only Dock wrapper. Same command seam, same arg shapes.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Track, Clip, RenderColor, RenderLora, RenderQA } from "../types";
import { qaReadoutView } from "./qaReadout";
import { pickGenClip, isSectionScoped } from "./genClip";
import { isTransformPreview } from "../capabilities";
import { resolveSa3Available, engineBadgeView, renderedByLabel } from "./engineBadge";
import { amountToNl, nlToAmount } from "./reimagineAmount";

export function GenDrawer({ track, selectedClipId }: { track: Track; selectedClipId?: string }) {
  const exec = useStore((s) => s.exec);
  const colorsAvail = useStore((s) => s.availableColors);
  const sa3Available = useStore((s) => s.sa3Available);
  const loadColors = useStore((s) => s.loadColors);
  const loadTransformTargets = useStore((s) => s.loadTransformTargets);
  const loadLoras = useStore((s) => s.loadLoras);
  const qaByClip = useStore((s) => s.qaByClip);
  // GEN-WARMUP — genServiceState distinguishes "still cold-starting, keep waiting" from a
  // genuine terminal failure; see store/jobs.ts. Retry on mount just like before (the
  // guards inside load* make a second in-flight call, or an already-loaded one, a no-op).
  const genServiceState = useStore((s) => s.genServiceState);
  const genServiceError = useStore((s) => s.genServiceError);
  useEffect(() => { loadColors(); loadTransformTargets(); loadLoras(); }, [loadColors, loadTransformTargets, loadLoras]);
  const retryService = () => { loadColors(); loadTransformTargets(); loadLoras(); };

  // Generative runs on ANY clip type — a MIDI/drum clip is auto-bounced to audio by the
  // backend before the model. Target the SELECTED clip when it's on this track, else the
  // track's first clip; the empty-state shows only when the track has no clips at all.
  const clip = pickGenClip(track, selectedClipId);
  if (!clip) return <div className="gen" data-testid="generative"><div className="gen-head"><span className="gen-title">⃝ GENERATIVE</span></div><span className="rack-empty">Add a clip on this track to re-imagine or transform it.</span></div>;
  const rl = clip.renderLayer;
  // sa3 was inferred from "does the colour rack have entries" — but the FakeAdapter returns a
  // populated rack too, so a guest Mac without the real model looked identical to one with it.
  // /colors now reports the ground truth directly; resolveSa3Available only falls back to the
  // old proxy when talking to a service that predates the field (sa3Available === undefined).
  const sa3 = resolveSa3Available(sa3Available, colorsAvail.length);
  const badge = engineBadgeView(sa3);

  return (
    <div className="gen" data-testid="generative">
      <div className="gen-head">
        <span className="gen-title">⃝ GENERATIVE</span>
        <span className={`engine-badge eb-${sa3 ? "sa3" : "preview"}`} title={badge.title} data-testid="engine-badge">{badge.label}</span>
        <span className="gen-clip">{rl?.mode === "sing" ? "sing" : rl?.mode === "transform" ? "transform" : sa3 ? "stable audio 3" : "fake"} · {clip.name}</span>
      </div>
      {!rl ? (
        <>
          {genServiceState === "error" ? (
            // A real, actionable failure (dead python3, broken venv — never surfaced this
            // way for a merely-cold-starting service, see the "warming" branch below).
            <div className="gen-service-status gen-service-error" data-testid="gen-service-error" role="alert">
              <span>Generative service unavailable{genServiceError ? ` — ${genServiceError}` : ""}.</span>
              <button className="btn rack-add" data-testid="gen-service-retry" onClick={retryService}>Retry</button>
            </div>
          ) : (genServiceState === "idle" || genServiceState === "warming") && colorsAvail.length === 0 ? (
            // Cold launch: the Python service is still spawning / importing / (SA3) loading
            // the model. Distinct from the error state above so a producer who opens the
            // Generate tab within the first second or two of app launch sees a loading state,
            // not a dead end — colours/targets/LoRAs populate here automatically once the
            // retry loop in store/jobs.ts lands them, no need to reopen the tab.
            <div className="gen-service-status gen-service-warming" data-testid="gen-service-warming" role="status">
              starting generative service…
            </div>
          ) : null}
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

/** A/B the render against what it replaced.
 *
 *  This is the only one of the three "commit" commands on a render layer that does real
 *  audio work rather than writing a status label: bypass_layer repoints a wave clip's own
 *  source back to `originalSourceRef`, and for the MIDI/drum beneath-model it un-mutes the
 *  source MIDI while muting the hidden render — so exactly one of the two is audible.
 *
 *  `bypassed` is server truth (it comes back on rl.status), so the pressed state is read,
 *  never held locally — same discipline as the Live button next to it. The label says what
 *  you are HEARING rather than what the button will do, because "is this the render or the
 *  original?" is the question you actually have while A/Bing, and the status pill alone
 *  answers it too slowly to be useful mid-listen. */
function BypassToggle({ clipId, bypassed, originalLabel }: { clipId: string; bypassed: boolean; originalLabel: string }) {
  const exec = useStore((s) => s.exec);
  return (
    <button className={`btn${bypassed ? " on" : ""}`} data-testid="gen-bypass" aria-pressed={bypassed}
      title={bypassed ? `Bypassed — you're hearing ${originalLabel}. Click to hear the re-imagine again.`
                      : `A/B — click to hear ${originalLabel} instead of the re-imagine.`}
      onClick={() => void exec("bypass_layer", { clipId, bypassed: !bypassed })}>
      {bypassed ? `◉ ${originalLabel}` : "A/B"}
    </button>
  );
}

/** Freeze / thaw the reactive loop.
 *
 *  With a render live, every edit to the source (a note, a trim, a plugin knob) silently
 *  re-runs the model. That is the feature — until you are past re-imagining and just want to
 *  arrange, at which point it is a queue of renders you will never listen to. Freeze keeps the
 *  audio you have and stops re-rendering; thawing re-arms it.
 *
 *  The pressed state reads `rl.reactive`, NOT `rl.status`. Both carry the freeze, but a param
 *  edit overwrites status with "dirty" while the layer stays frozen — a status-driven badge
 *  would blink off at the first knob turn and claim the layer had thawed itself. */
function FreezeToggle({ clipId, frozen }: { clipId: string; frozen: boolean }) {
  const exec = useStore((s) => s.exec);
  return (
    <button className={`btn${frozen ? " on" : ""}`} data-testid="gen-freeze" aria-pressed={frozen}
      title={frozen ? "Frozen — edits no longer re-render this clip. Click to thaw and re-imagine on every edit again."
                    : "Freeze — keep this render and stop re-rendering it every time you edit the clip."}
      onClick={() => void exec(frozen ? "unfreeze_layer" : "freeze_layer", { clipId })}>
      {frozen ? "◉ Frozen" : "Freeze"}
    </button>
  );
}

function GenBody({ clip, track, qa }: { clip: Clip; track: Track; qa?: RenderQA }) {
  const qaView = qaReadoutView(qa);
  // Per-render truth: the drawer header badge says what THIS Mac's service would render
  // next; this says what actually produced the render sitting in the clip right now (its own
  // manifest's `adapter`) — the two can disagree (e.g. SA3 went down mid-session). Silent when
  // the render came from the real model — that's the unsurprising default.
  const renderedBy = renderedByLabel(qa?.adapter);
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
  const displayGroup = (g: string) => g.charAt(0).toUpperCase() + g.slice(1);
  // Colours sharing a `group` are ONE control with a mode toggle (Sustain · Gentle ⇄ Swell).
  // Collapse the add-dropdown to one entry per group (keep its first = the default mode).
  const seenGroups = new Set<string>();
  const addOptions = addable.filter((c) => {
    if (!c.group) return true;
    if (seenGroups.has(c.group)) return false;
    seenGroups.add(c.group);
    return true;
  });
  const isTransform = rl.mode === "transform";
  const isSing = rl.mode === "sing";
  const singable = isSing ? (track.lyricSheet?.lines ?? []).filter((l) => l.singable).length : 0;
  const singBlocked = isSing && singable === 0;

  return (
    <div className="gen-body" data-render-status={rl.status}>
      {isSing ? <SingControls track={track} /> : isTransform ? <TransformControls clip={clip} /> : (<>
      <label className="nparam" data-testid="gen-nl-row"
        title="How much to keep vs re-imagine — 0 keeps your original, 100 fully re-imagines. Lab unlocks up to a full generate-from-scratch.">
        <span className="nlabel">re-imagine</span>
        <span className="nslider"><input type="range" min={0} max={100} step={1}
          aria-label="re-imagine amount"
          data-testid="gen-nl"
          value={nlToAmount(rl.nl ?? 0.4, labMode)}
          onChange={(e) => void exec("set_render_param", { clipId: clip.id, nl: amountToNl(Number(e.target.value), labMode), lab: labMode })} /></span>
        <span className="nval">{nlToAmount(rl.nl ?? 0.4, labMode)}</span>
      </label>
      {active.map((c) => {
        const meta = colorsAvail.find((m) => m.name === c.name);
        // A grouped colour (e.g. sustain) is shown as its group name + a mode toggle that
        // swaps the active colour between the group's modes (Gentle L17 ⇄ Swell L8), keeping
        // the value. Keyed by group so the slider doesn't remount when the mode flips.
        const modes = meta?.group ? colorsAvail.filter((m) => m.group === meta.group) : [];
        return (
          <label key={meta?.group ?? c.name} className="nparam">
            <span className="nlabel">{meta?.group ? displayGroup(meta.group) : c.name}{meta && meta.astd_max <= 0.1 && <span className="cap-tag">CAPPED</span>}</span>
            {modes.length > 1 && (
              <span className="mode-toggle" role="group" aria-label={`${displayGroup(meta!.group!)} mode`}>
                {modes.map((m) => (
                  <button key={m.name} type="button" className={"mode-btn" + (m.name === c.name ? " on" : "")}
                    data-testid={`color-mode-${(m.mode ?? m.name).toLowerCase()}`}
                    aria-pressed={m.name === c.name} title={`peak layer ${m.peak_layer}`}
                    onClick={() => setColors(active.map((a) => (a.name === c.name ? { ...a, name: m.name } : a)))}>{m.mode}</button>
                ))}
              </span>
            )}
            <input type="range" min={0} max={100} step={1} value={Math.round(c.value)}
              onChange={(e) => setColors(active.map((a) => (a.name === c.name ? { ...a, value: Number(e.target.value) } : a)))} />
            <button className="btn x" onClick={() => setColors(active.filter((a) => a.name !== c.name))}>✕</button>
          </label>
        );
      })}
      {active.length < 3 && addOptions.length > 0 && (
        <select className="btn ghost color-add" data-testid="color-add" value="" onChange={(e) => e.target.value && setColors([...active, { name: e.target.value, value: 65 }])}>
          <option value="">+ colour…</option>
          {addOptions.map((c) => <option key={c.name} value={c.name}>{c.group ? displayGroup(c.group) : c.name}{c.verdict === "WEAK" ? " (weak)" : ""}</option>)}
        </select>
      )}
      <LoraRack clip={clip} />
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
        {renderedBy && (
          <span className="gen-rendered-by tc" data-testid="rendered-by"
            title="This render was produced by the preview engine, not the real model">{renderedBy}</span>
        )}
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
            <button className="btn" data-testid="gen-render" disabled={singBlocked}
              title={singBlocked ? "assert words on a flowed lyric line first" : undefined}
              onClick={() => void exec("render_layer", { clipId: clip.id })}>{rl.hasArtifact ? "Re-render" : "Render"}</button>
            <button className="btn" disabled={!rl.hasArtifact} data-testid="gen-accept" onClick={async () => { const r = await exec("accept_render", { clipId: clip.id }); if (r.ok) bumpCelebrate(); }}>Accept</button>
            <button className="btn" disabled={!rl.hasArtifact} onClick={() => void exec("reject_render", { clipId: clip.id })}>Reject</button>
          </>
        ) : isSectionScoped(clip) ? (
          // A SECTION render — scoped to part of the clip by the timeline's range selection.
          // It cannot apply in place (repointing the source would replace the whole clip), so
          // MoshOps::applyRenderInPlace bails and the result waits on the legacy landing. That
          // makes this the one and only shape where Bounce does real work: everywhere else
          // cmdAcceptRender takes a no-op branch and bounce_layer_to_clip just writes a label,
          // which is why no other branch here offers it.
          //
          // No Live, no A/B, no Reset: all three are about a render that IS the clip's audio.
          <>
            <button className="btn" data-testid="gen-render" onClick={() => void exec("render_layer", { clipId: clip.id })}>Re-imagine section</button>
            <button className="btn" data-testid="gen-bounce" disabled={!rl.hasArtifact}
              title={rl.hasArtifact
                ? "Bounce this section down to its own clip on the Neural Renders lane"
                : "Render the section first — there is nothing to bounce yet"}
              onClick={() => void exec("bounce_layer_to_clip", { clipId: clip.id })}>Bounce to clip</button>
          </>
        ) : clip.type === "wave" ? (
          // Wave clips auto-apply in place — the waveform swaps to the result instantly.
          // No accept/reject; Reset restores the original. "Live" arms render-ahead: as you play,
          // the re-imagine lays down ahead of the playhead (Lane A); a knob change re-lays from
          // where you are. It fills the clip in place, so Reset still restores the original.
          <>
            <button className="btn" data-testid="gen-render" onClick={() => void exec("render_layer", { clipId: clip.id })}>Re-imagine</button>
            <button className={`btn${rl.liveArmed ? " on" : ""}`} data-testid="gen-live" aria-pressed={!!rl.liveArmed}
              title="Live — render the re-imagine ahead of the playhead as you play; turn a knob and hear it fill in ahead of you"
              onClick={() => void exec("render_ahead_arm", { clipId: clip.id, armed: !rl.liveArmed })}>{rl.liveArmed ? "◉ Live" : "Live"}</button>
            {/* Only once the render IS the clip's audio — before that there is nothing to A/B against. */}
            {rl.appliedInPlace && <BypassToggle clipId={clip.id} bypassed={rl.status === "bypassed"} originalLabel="original" />}
            {/* Same gate reactiveTouch itself uses (a render is LIVE) — a dormant layer has no
                loop to freeze, so offering the button would be theatre. */}
            {rl.appliedInPlace && <FreezeToggle clipId={clip.id} frozen={rl.reactive === false} />}
            <button className="btn" data-testid="gen-reset" disabled={!rl.hasOriginal} title="Restore the original audio" onClick={() => void exec("reset_render_layer", { clipId: clip.id })}>Reset</button>
          </>
        ) : (
          // MIDI/drum: the render lands as HIDDEN audio beneath the muted MIDI (Phase 2) — instant,
          // and the MIDI stays editable underneath. No accept step; Reset un-mutes the MIDI and drops
          // the hidden audio.
          <>
            <button className="btn" data-testid="gen-render" onClick={() => { void exec("render_layer", { clipId: clip.id }); if (!rl.reimagineActive) bumpCelebrate(); }}>Re-imagine</button>
            {/* Bypass here swaps which of the two SOUNDS: the live instrument, or the hidden
                render beneath it. Reset next to it is the destructive one — it drops the render. */}
            {rl.reimagineActive && <BypassToggle clipId={clip.id} bypassed={rl.status === "bypassed"} originalLabel="MIDI" />}
            {rl.reimagineActive && <FreezeToggle clipId={clip.id} frozen={rl.reactive === false} />}
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

// LoRA rack — trained style adapters applied to the SA3 re-imagine at 0–100 strength,
// composing with colours/prompt/seed (unbounded + unclamped, ordered: stacks merge
// sequentially; >100 = deliberate overdrive). The library is a drop-in dir
// (~/Library/Mosh/loras/sa3); hidden when it's empty. Trigger tokens auto-inject into
// the prompt server-side (progressive disclosure — surfaced only in the row tooltip).
// The muted Σ readout is informational, never blocking (no budget rule — owner call).
function LoraRack({ clip }: { clip: Clip }) {
  const exec = useStore((s) => s.exec);
  const lorasAvail = useStore((s) => s.availableLoras);
  const rl = clip.renderLayer!;
  const active: RenderLora[] = rl.loras ?? [];
  // The rack is the KEPT shelf. `sa3/lab/` checkpoints come down the same
  // list_loras call (one endpoint, one scan) and must be filtered out here, or a
  // single training run drops six near-identical entries into the producer's
  // "+ LoRA…" menu and buries the adapters they actually chose to keep.
  //
  // Filtered for the menu and the is-there-anything check ONLY — `lorasAvail`
  // stays whole for the metadata lookup below, so a lab take that IS on the clip
  // (auditioned, or stacked) still renders with its real display name instead of
  // degrading to a bare filename.
  const library = lorasAvail.filter((m) => m.family !== "lab");
  if (library.length === 0 && active.length === 0) return null;
  const setLoras = (next: RenderLora[]) => exec("set_render_param", { clipId: clip.id, loras: next });
  const addable = library.filter((m) => (m.valid ?? true) && !active.some((a) => a.name === m.name));
  const sum = active.reduce((s, a) => s + a.value / 100, 0);
  return (
    <>
      {active.map((l) => {
        const meta = lorasAvail.find((m) => m.name === l.name);
        const tip = [
          meta?.trigger ? `trigger “${meta.trigger}” is added to the prompt automatically` : "",
          meta?.hint ?? "", meta?.notes ?? "",
        ].filter(Boolean).join(" — ");
        return (
          <label key={l.name} className="nparam" data-testid={`lora-row-${l.name}`}>
            <span className="nlabel" title={tip || undefined}>🧬 {meta?.displayName ?? l.name}</span>
            <input type="range" min={0} max={100} step={1} value={Math.min(100, Math.round(l.value))}
              aria-label={`${meta?.displayName ?? l.name} LoRA strength`}
              onChange={(e) => setLoras(active.map((a) => (a.name === l.name ? { ...a, value: Number(e.target.value) } : a)))} />
            <button className="btn x" onClick={() => setLoras(active.filter((a) => a.name !== l.name))}>✕</button>
          </label>
        );
      })}
      {addable.length > 0 && (
        <select className="btn ghost color-add" data-testid="lora-add" value=""
          onChange={(e) => e.target.value && setLoras([...active, { name: e.target.value, value: 70 }])}>
          <option value="">+ LoRA…</option>
          {addable.map((m) => <option key={m.name} value={m.name}>{m.displayName}</option>)}
        </select>
      )}
      {active.length > 1 && (
        <span className="rack-empty" data-testid="lora-sum" title="combined adapter strength — informational only">
          Σ {sum.toFixed(2)}
        </span>
      )}
    </>
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
  const singable = lines.filter((l) => l.singable).length;
  return (
    <div className="sing-controls">
      <label className="nparam">
        <span className="nlabel">flow</span>
        <span className="tc" data-testid="sing-flow">{flowed}/{lines.length} lines carry your take's flow</span>
      </label>
      <label className="nparam">
        <span className="nlabel">asserted flow</span>
        <span className="tc" data-testid="sing-asserted">{singable}/{lines.length} lines have asserted words and flow</span>
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
      {flowed > 0 && singable === 0 && (
        <span className="rack-empty">Flow is ready. Assert the words in Lyrics before rendering.</span>
      )}
      {flowed > 0 && flowed < lines.length && (
        // Mirrors the score author's honest skip: typed-later lines have no take flow,
        // so the render leaves them out rather than inventing timing.
        <span className="rack-empty" data-testid="sing-skip-hint">
          {lines.length - flowed} line{lines.length - flowed === 1 ? "" : "s"} without take flow will be skipped — rebuild the flow to sing them.
        </span>
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
  const preview = useStore((s) => isTransformPreview(s.capabilities));
  const rl = clip.renderLayer!;
  const target = rl.target ?? "";
  const strength = rl.strength ?? 65;
  const known = targets.some((t) => t.name === target);
  const setTarget = (t: string) => void exec("set_render_param", { clipId: clip.id, target: t });
  return (
    <div className="xform-controls">
      {preview && (
        <span className="xform-preview tc" data-testid="xform-preview"
          title="No RAVE model installed on this Mac — this renders a deterministic placeholder tilt/saturation, not a real instrument transform">preview</span>
      )}
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
