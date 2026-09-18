import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Clip, ClipTake, Snapshot, Track } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";

/** The clip the Booth shows for a track: the take the lifecycle just landed, else the track's
 *  comp (the clip carrying takes — a transport-toggle stop lands there without telling the
 *  store), else its first wave clip, else its first clip. */
export function boothClipFor(
  track: Pick<Track, "clips"> | undefined,
  lastTakeClipId: string | null,
): Clip | undefined {
  const clips = track?.clips ?? [];
  return clips.find((c) => c.id === lastTakeClipId)
    ?? clips.find((c) => (c.numTakes ?? c.takes?.length ?? 0) > 0)
    ?? clips.find((c) => c.type === "wave")
    ?? clips[0];
}

export function BoothView({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const recording = useStore((s) => s.transport.recording);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const lastTakeClipId = useStore((s) => s.lastTakeClipId);
  const keepTake = useStore((s) => s.keepTake);
  const navTake = useStore((s) => s.navTake);
  const setPosture = useV3((s) => s.setPosture);
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks);

  const track = snapshot.tracks.find((t) => t.id === selectedTrackId)
    ?? snapshot.tracks.find((t) => t.armed)
    ?? snapshot.tracks[0];
  const clip = boothClipFor(track, lastTakeClipId);
  // The store's keepTake / navTake act on lastTakeClipId, which only the recording lifecycle's
  // stopRecord sets; the Record button here (and the transport's) stops through the transport
  // toggle, which lands the take but leaves that id null. Drive the clip this view shows.
  const viaLifecycle = !!clip && clip.id === lastTakeClipId;

  const [takes, setTakes] = useState<ClipTake[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (clip?.type === "wave") ensurePeaks(clip.id);
  }, [clip, ensurePeaks]);

  useEffect(() => {
    if (!clip) { setTakes([]); return; }
    let cancelled = false;
    void exec("list_takes", { clipId: clip.id }).then((res) => {
      if (cancelled) return;
      const data = res.ok ? (res as { data?: { takes?: ClipTake[]; currentTakeIndex?: number } }).data : undefined;
      setTakes(data?.takes ?? []);
      setCurrentIndex(data?.currentTakeIndex ?? clip.currentTakeIndex ?? 0);
    });
    return () => { cancelled = true; };
  }, [clip, exec, clip?.numTakes, clip?.currentTakeIndex, recording]);

  const step = async (delta: number) => {
    if (!clip) return;
    if (viaLifecycle) { await navTake(delta); return; }
    const next = Math.max(0, Math.min(takes.length - 1, currentIndex + delta));
    if (next === currentIndex) return;
    const r = await exec("set_current_take", { clipId: clip.id, takeIndex: next });
    if (r.ok) await useStore.getState().refresh();
  };
  const keep = async () => {
    if (!clip) return;
    if (viaLifecycle) { await keepTake(); return; }
    const r = await exec("keep_take", { clipId: clip.id });
    if (r.ok) await useStore.getState().refresh();
  };

  return (
    <div className="booth-stage" data-testid="v3-booth">
      <div className="booth-main">
        <div className="hero-wrap">
          <div className="hero-lane" data-testid="v3-booth-hero">
            <SilhouetteWave
              peaks={clip ? peaks[clip.id] : undefined}
              selected
              live={recording}
              beats={32}
              className="cwave bigwave"
            />
          </div>
        </div>
        <div className="row" style={{ display: "flex", gap: 8 }}>
          <button type="button" className={`btn recb${recording ? " on" : ""}`} data-testid="v3-booth-record"
            onClick={() => void useStore.getState().toggleRecord()}>
            Record
          </button>
          <button type="button" className="btn ghost" data-testid="v3-booth-studio"
            onClick={() => setPosture("studio")}>
            ← Studio
          </button>
        </div>
      </div>
      <aside className="booth-side" data-testid="v3-takes">
        <span className="sec">Takes</span>
        {takes.length === 0 && <div className="set-hint">No takes yet</div>}
        {takes.map((take) => {
          const current = take.index === currentIndex || !!take.isCurrent;
          return (
            <button key={take.id ?? take.index} type="button"
              className={`take${current ? " kept" : ""}`} data-testid="v3-take"
              onClick={() => clip && void exec("set_current_take", { clipId: clip.id, takeIndex: take.index })}>
              <b>{take.description ?? `Take ${take.index + 1}`}</b>
              {current && <span className="chip on">current</span>}
            </button>
          );
        })}
        {takes.length > 0 && (
          <div className="row" style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn sm" data-testid="v3-take-prev" onClick={() => void step(-1)}>Prev</button>
            <button type="button" className="btn sm" data-testid="v3-take-next" onClick={() => void step(1)}>Next</button>
            <button type="button" className="btn pri sm" data-testid="v3-take-keep" onClick={() => void keep()}>Keep</button>
          </div>
        )}
      </aside>
    </div>
  );
}
