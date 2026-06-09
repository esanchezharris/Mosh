import { useEffect } from "react";
import { useStore } from "../store";
import type { Track, Clip, RenderColor } from "../types";

// Tier-B generative drawer (05). When the SA3 backend is available (list_colors
// returns a rack), this drives the real Stable Audio 3 model: re-imagine/generate
// + an ASTD-clamped ≤3-colour rack + Lab unlock + a judge-panel quality readout.
// Falls back to the FakeAdapter when SA3 isn't running. Every action is a command.
export function GenPanel({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const progress = useStore((s) => s.renderProgress);
  const colorsAvail = useStore((s) => s.availableColors);
  const loadColors = useStore((s) => s.loadColors);
  const qaByClip = useStore((s) => s.qaByClip);

  useEffect(() => {
    loadColors();
  }, [loadColors]);

  const clip = track.clips.find((c) => c.type === "wave");
  if (!clip) return null;
  const rl = clip.renderLayer;
  const sa3 = colorsAvail.length > 0;

  return (
    <div className="genpanel">
      <div className="gen-head">
        <span className="gen-title">⃝ generative</span>
        <span className="gen-clip">{sa3 ? "stable audio 3" : "fake"} · {clip.name}</span>
      </div>

      {!rl ? (
        <button
          className="rack-add"
          onClick={() =>
            exec("create_render_layer", {
              clipId: clip.id,
              adapter: sa3 ? "stable_audio3" : "fake",
              mode: "reimagine",
              modelVariant: sa3 ? "sa3-medium" : "",
            })
          }
        >
          + Render layer
        </button>
      ) : (
        <GenBody clip={clip} progress={progress[clip.id] ?? 0} qa={qaByClip[clip.id]} />
      )}
    </div>
  );
}

function GenBody({
  clip,
  progress,
  qa,
}: {
  clip: Clip;
  progress: number;
  qa?: { pq?: number | null; pq_base?: number | null; flags?: string[] };
}) {
  const exec = useStore((s) => s.exec);
  const colorsAvail = useStore((s) => s.availableColors);
  const labMode = useStore((s) => s.labMode);
  const setLab = useStore((s) => s.setLab);
  const rl = clip.renderLayer!;
  const active: RenderColor[] = rl.colors ?? [];
  const rendering = rl.status === "rendering" || rl.status === "queued";

  const setColors = (next: RenderColor[]) =>
    exec("set_render_param", { clipId: clip.id, colors: next.slice(0, 3), lab: labMode });

  const blockedBy = (name: string) => {
    const meta = colorsAvail.find((c) => c.name === name);
    return (meta?.no_stack_with ?? []).some((n) => active.some((a) => a.name === n));
  };
  const addable = colorsAvail.filter(
    (c) => !active.some((a) => a.name === c.name) && !blockedBy(c.name)
  );

  return (
    <div className="gen-body">
      {/* Colour rack: ≤3 ASTD sliders */}
      {active.map((c) => {
        const meta = colorsAvail.find((m) => m.name === c.name);
        return (
          <label key={c.name} className="nparam color-row">
            <span className="nlabel" title={meta ? `${meta.verdict} · L${meta.peak_layer} · α≤${meta.astd_max}` : ""}>
              {c.name}
              {meta && meta.astd_max <= 0.1 && <span className="cap-tag">capped</span>}
            </span>
            <span className="nslider">
              <input
                type="range" min={0} max={100} step={1} value={Math.round(c.value)}
                onChange={(e) =>
                  setColors(active.map((a) => (a.name === c.name ? { ...a, value: Number(e.target.value) } : a)))
                }
              />
              <span className="astd-center" />
            </span>
            <button className="x" title="remove" onClick={() => setColors(active.filter((a) => a.name !== c.name))}>✕</button>
          </label>
        );
      })}
      {active.length < 3 && addable.length > 0 && (
        <select
          className="color-add"
          value=""
          onChange={(e) => e.target.value && setColors([...active, { name: e.target.value, value: 65 }])}
        >
          <option value="">+ colour…</option>
          {addable.map((c) => (
            <option key={c.name} value={c.name}>{c.name}{c.verdict === "WEAK" ? " (weak)" : ""}</option>
          ))}
        </select>
      )}

      {/* Engine cluster */}
      <label className="nparam">
        <span className="nlabel">nl</span>
        <span className="nslider">
          <input
            type="range" min={0} max={50} step={1} value={Math.round(Number(rl.nl ?? 0.45) * 100)}
            onChange={(e) => exec("set_render_param", { clipId: clip.id, nl: Number(e.target.value) / 100 })}
          />
        </span>
        <span className="nval">{Number(rl.nl ?? 0.45).toFixed(2)}</span>
      </label>

      <div className="gen-status">
        <span className={`gen-badge st-${rl.status}`}>{rl.status}</span>
        {rendering && (
          <span className="gen-prog"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
        )}
        <button className={`mixbtn ${labMode ? "lab-on" : ""}`} title="Lab — unlock the ASTD clamp" onClick={() => setLab(!labMode)}>
          {labMode ? "⚠ LAB" : "Lab"}
        </button>
        <span className="gen-seed">seed {rl.seed}</span>
      </div>

      {qa && (qa.pq != null || (qa.flags && qa.flags.length > 0)) && (
        <div className="gen-qa" title="judge-panel production quality">
          {qa.pq != null && <span>pq {qa.pq}{qa.pq_base != null ? ` / ${qa.pq_base}` : ""}</span>}
          {qa.flags?.map((f) => <span key={f} className={`qa-flag ${f === "quality_degraded" ? "warn" : ""}`}>{f}</span>)}
        </div>
      )}

      <div className="gen-actions">
        <button onClick={() => exec("render_layer", { clipId: clip.id })}>
          {rl.hasArtifact ? "Re-render" : "Render"}
        </button>
        {rendering && <button onClick={() => exec("cancel_render", { clipId: clip.id })}>Cancel</button>}
        <button disabled={!rl.hasArtifact} onClick={() => exec("accept_render", { clipId: clip.id })}>Accept</button>
        <button disabled={!rl.hasArtifact} onClick={() => exec("reject_render", { clipId: clip.id })}>Reject</button>
        <button onClick={() => exec("set_render_param", { clipId: clip.id, seed: Number(rl.seed) + 1 })} title="new take">⟳ seed</button>
      </div>
    </div>
  );
}
