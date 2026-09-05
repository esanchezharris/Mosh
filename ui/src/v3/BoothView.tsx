import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { ClipTake, Snapshot } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";

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
  const clip = track?.clips.find((c) => c.id === lastTakeClipId)
    ?? track?.clips.find((c) => c.type === "wave")
    ?? track?.clips[0];

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
            <button type="button" className="btn sm" onClick={() => void navTake(-1)}>Prev</button>
            <button type="button" className="btn sm" onClick={() => void navTake(1)}>Next</button>
            <button type="button" className="btn pri sm" onClick={() => void keepTake()}>Keep</button>
          </div>
        )}
      </aside>
    </div>
  );
}
