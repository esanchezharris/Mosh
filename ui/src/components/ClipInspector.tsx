import { useStore } from "../store";
import type { Snapshot, Clip } from "../types";

// The clip inspector (Stage 24): pitch / stretch / gain / reverse / slice for
// wave clips — every control is one of the existing or new clip commands.
export function ClipInspector({ snapshot }: { snapshot: Snapshot }) {
  const inspecting = useStore((s) => s.inspecting);
  const setInspecting = useStore((s) => s.setInspecting);
  const exec = useStore((s) => s.exec);
  const snapDiv = useStore((s) => s.snapDiv);

  if (!inspecting) return null;
  let clip: Clip | null = null;
  for (const tr of snapshot.tracks)
    for (const c of tr.clips) if (c.id === inspecting.clipId) clip = c;
  if (!clip) {
    setTimeout(() => setInspecting(null), 0);
    return null;
  }
  const theClip = clip;
  const isWave = theClip.type === "wave";

  return (
    <div className="inspector" style={{ left: inspecting.x, top: inspecting.y }}>
      <div className="insp-head">
        <b>{theClip.name}</b>
        <button className="mini" onClick={() => setInspecting(null)}>✕</button>
      </div>
      {!isWave ? (
        <div className="insp-row insp-hint">MIDI clip — double-click it for the piano roll</div>
      ) : (
        <>
          <label className="insp-row">
            <span>pitch</span>
            <input
              type="range" min={-12} max={12} step={1}
              value={theClip.pitchSemis ?? 0}
              onChange={(e) => exec("set_clip_pitch", { clipId: theClip.id, semitones: Number(e.target.value) })}
            />
            <i>{(theClip.pitchSemis ?? 0).toFixed(0)} st</i>
          </label>
          <label className="insp-row">
            <span>stretch</span>
            <input
              type="range" min={0.5} max={2} step={0.05}
              value={theClip.speedRatio ?? 1}
              onChange={(e) => exec("set_clip_stretch", { clipId: theClip.id, ratio: Number(e.target.value) })}
            />
            <i>×{(theClip.speedRatio ?? 1).toFixed(2)}</i>
          </label>
          <label className="insp-row">
            <span>gain</span>
            <input
              type="range" min={-24} max={12} step={0.5}
              value={theClip.gainDb ?? 0}
              onChange={(e) => exec("set_clip_gain", { clipId: theClip.id, db: Number(e.target.value) })}
            />
            <i>{(theClip.gainDb ?? 0).toFixed(1)} dB</i>
          </label>
          <label className="insp-row">
            <span>loop</span>
            <input
              type="range" min={0} max={16} step={1}
              value={theClip.loopBeats ?? 0}
              title="Loop the clip content every N beats (0 = off); stretch the clip longer to hear repeats"
              onChange={(e) => exec("set_clip_loop", { clipId: theClip.id, loopBeats: Number(e.target.value) })}
            />
            <i>{(theClip.loopBeats ?? 0) > 0 ? `${theClip.loopBeats}b` : "off"}</i>
          </label>
          <label className="insp-row">
            <span>fade in</span>
            <input
              type="range" min={0} max={2} step={0.05}
              value={theClip.fadeInSec ?? 0}
              onChange={(e) => exec("set_clip_fades", { clipId: theClip.id, fadeInSec: Number(e.target.value) })}
            />
            <i>{(theClip.fadeInSec ?? 0).toFixed(2)}s</i>
          </label>
          <label className="insp-row">
            <span>fade out</span>
            <input
              type="range" min={0} max={2} step={0.05}
              value={theClip.fadeOutSec ?? 0}
              onChange={(e) => exec("set_clip_fades", { clipId: theClip.id, fadeOutSec: Number(e.target.value) })}
            />
            <i>{(theClip.fadeOutSec ?? 0).toFixed(2)}s</i>
          </label>
          <div className="insp-row">
            <button
              className={`pr-tool ${theClip.autoCrossfade ? "on" : ""}`}
              title="Crossfade automatically where clips overlap on this track"
              onClick={() => exec("set_clip_fades", { clipId: theClip.id, autoCrossfade: !theClip.autoCrossfade })}
            >
              ⤬ auto-xfade
            </button>
            <button
              className={`pr-tool ${theClip.reversed ? "on" : ""}`}
              onClick={() => exec("set_clip_reversed", { clipId: theClip.id, reversed: !theClip.reversed })}
            >
              {theClip.reversed ? "↪ reversed" : "↩ reverse"}
            </button>
            <button
              className="pr-tool"
              title={`Slice the clip on the ${snapDiv} grid`}
              onClick={() => {
                void exec("slice_clip", { clipId: theClip.id, grid: snapDiv === "bar" ? "1/4" : snapDiv });
                setInspecting(null);
              }}
            >
              ✂ slice {snapDiv}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
