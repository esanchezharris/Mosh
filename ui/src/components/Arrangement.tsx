import { useStore } from "../store";
import type { Snapshot, Track, Clip } from "../types";

const PX_PER_SEC = 80;
const RULER_SECONDS = 32;

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const pos = snapshot.transport.position;

  const seekTo = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const seconds = Math.max(0, (clientX - rect.left) / PX_PER_SEC);
    void exec("set_transport", { position: seconds });
  };

  return (
    <div className="arrange">
      <Toolbar />

      <div className="timeline">
        <div className="tl-head">
          <div className="lane-gutter">tracks</div>
          <div
            className="ruler"
            onClick={(e) => seekTo(e.clientX, e.currentTarget)}
          >
            {Array.from({ length: RULER_SECONDS }, (_, i) => (
              <div className="tick" key={i} style={{ left: i * PX_PER_SEC }}>
                <span>{i}</span>
              </div>
            ))}
            <div className="playhead" style={{ left: pos * PX_PER_SEC }} />
          </div>
        </div>

        <div className="lanes">
          {snapshot.tracks.length === 0 && (
            <div className="empty-hint">
              No tracks yet — add a track or drop in a test tone.
            </div>
          )}
          {snapshot.tracks.map((tr) => (
            <TrackRow key={tr.id} track={tr} playheadX={pos * PX_PER_SEC} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Toolbar() {
  const exec = useStore((s) => s.exec);
  return (
    <div className="toolbar">
      <button onClick={() => exec("create_track", {})}>+ Track</button>
      <button onClick={() => exec("add_test_tone_clip", { seconds: 2, freq: 220 })}>
        + Test Tone
      </button>
      <span className="sep" />
      <button onClick={() => exec("undo", {})}>↶ Undo</button>
      <button onClick={() => exec("redo", {})}>↷ Redo</button>
      <span className="sep" />
      <button onClick={() => exec("save", {})}>Save</button>
      <button onClick={() => exec("reload", {})}>Reload</button>
    </div>
  );
}

function TrackRow({ track, playheadX }: { track: Track; playheadX: number }) {
  const exec = useStore((s) => s.exec);
  return (
    <div className="track-row">
      <div className="track-head">
        <span className="track-name">{track.name || `Track ${track.index + 1}`}</span>
        <button
          className="mini"
          title="Remove track"
          onClick={() => exec("remove_track", { trackId: track.id })}
        >
          ✕
        </button>
      </div>
      <div className="lane">
        {track.clips.map((c) => (
          <ClipBlock key={c.id} clip={c} />
        ))}
        <div className="playhead lane-ph" style={{ left: playheadX }} />
      </div>
    </div>
  );
}

function ClipBlock({ clip }: { clip: Clip }) {
  const left = clip.start * PX_PER_SEC;
  const width = Math.max(8, clip.length * PX_PER_SEC);
  return (
    <div
      className={`clip ${clip.type}`}
      style={{ left, width }}
      title={`${clip.name} · ${clip.length.toFixed(2)}s`}
    >
      <span className="clip-name">{clip.name}</span>
      {clip.hasRenderLayer && <span className="rl-badge">RL</span>}
    </div>
  );
}
