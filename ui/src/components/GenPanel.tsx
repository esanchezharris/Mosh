import { useStore } from "../store";
import type { Track, Clip } from "../types";

// Tier-B generative drawer (05). Operates on the selected track's first wave
// clip's RenderLayer — every action is a MoshOps command. A re-imagine render is
// a JOB (async): submit → progress → audition → accept/reject. The source take
// keeps playing while it renders (no playback stall).
export function GenPanel({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const progress = useStore((s) => s.renderProgress);

  const clip = track.clips.find((c) => c.type === "wave");
  if (!clip) return null;
  const rl = clip.renderLayer;

  return (
    <div className="genpanel">
      <div className="gen-head">
        <span className="gen-title">⃝ generative</span>
        <span className="gen-clip">{clip.name}</span>
      </div>

      {!rl ? (
        <button
          className="rack-add"
          onClick={() => exec("create_render_layer", { clipId: clip.id, adapter: "fake" })}
        >
          + Render layer
        </button>
      ) : (
        <GenBody clip={clip} progress={progress[clip.id] ?? 0} />
      )}
    </div>
  );
}

function GenBody({ clip, progress }: { clip: Clip; progress: number }) {
  const exec = useStore((s) => s.exec);
  const rl = clip.renderLayer!;
  const grit = rl.colors?.find((c) => c.name === "grit")?.value ?? 0;
  const rendering = rl.status === "rendering" || rl.status === "queued";

  const setColor = (name: string, value: number) =>
    exec("set_render_param", { clipId: clip.id, colors: [{ name, value }] });

  return (
    <div className="gen-body">
      <label className="nparam">
        <span className="nlabel">grit</span>
        <span className="nslider">
          <input
            type="range" min={0} max={100} step={1} value={Math.round(grit)}
            onChange={(e) => setColor("grit", Number(e.target.value))}
          />
        </span>
        <span className="nval">{Math.round(grit)}</span>
      </label>
      <label className="nparam">
        <span className="nlabel">nl</span>
        <span className="nslider">
          <input
            type="range" min={0} max={50} step={1} value={Math.round((rl.nl ?? 0.4) * 100)}
            onChange={(e) => exec("set_render_param", { clipId: clip.id, nl: Number(e.target.value) / 100 })}
          />
        </span>
        <span className="nval">{(rl.nl ?? 0.4).toFixed(2)}</span>
      </label>

      <div className="gen-status">
        <span className={`gen-badge st-${rl.status}`}>{rl.status}</span>
        {rendering && (
          <span className="gen-prog"><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
        )}
        <span className="gen-seed">seed {rl.seed}</span>
      </div>

      <div className="gen-actions">
        <button onClick={() => exec("render_layer", { clipId: clip.id })}>
          {rl.hasArtifact ? "Re-render" : "Render"}
        </button>
        {rl.status === "rendering" && (
          <button onClick={() => exec("cancel_render", { clipId: clip.id })}>Cancel</button>
        )}
        <button
          disabled={!rl.hasArtifact}
          onClick={() => exec("accept_render", { clipId: clip.id })}
          title="A/B then keep — lands on the neural lane"
        >
          Accept
        </button>
        <button disabled={!rl.hasArtifact} onClick={() => exec("reject_render", { clipId: clip.id })}>
          Reject
        </button>
        <button
          onClick={() => exec("set_render_param", { clipId: clip.id, seed: rl.seed + 1 })}
          title="New seed = a different take at the same settings"
        >
          ⟳ seed
        </button>
      </div>
    </div>
  );
}
