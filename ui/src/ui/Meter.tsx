// Live level meter. The rAF loop reads the latest `levels` straight from the store
// (never a per-frame React render — the Moshi-loop discipline) and writes bar heights
// + a peak-hold tick to refs. Ballistics: instant attack, eased decay, a slower peak
// hold. dBFS in, fill out; a clip tint above 0 dBFS.

import { useEffect, useRef } from "react";
import { useStore } from "../store";

// -60 dBFS floor -> 0 fill, +6 dBFS -> full.
const norm = (db: number) => Math.max(0, Math.min(1, (db + 60) / 66));

function MeterBars({ trackId }: { trackId: string | null }) {
  const lRef = useRef<HTMLElement>(null);
  const rRef = useRef<HTMLElement>(null);
  const lHold = useRef<HTMLElement>(null);
  const rHold = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const v = { l: 0, r: 0 };
    const hold = { l: 0, r: 0 };
    const DECAY = 0.9;      // bar fall, units/sec
    const HOLD_DECAY = 0.4; // peak tick fall, slower
    const pick = () =>
      trackId ? useStore.getState().levels.tracks[trackId] : useStore.getState().levels.master;

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const lv = pick();
      const tl = lv ? norm(lv.l) : 0;
      const tr = lv ? norm(lv.r) : 0;
      v.l = tl > v.l ? tl : Math.max(tl, v.l - DECAY * dt);   // instant attack, eased decay
      v.r = tr > v.r ? tr : Math.max(tr, v.r - DECAY * dt);
      hold.l = v.l > hold.l ? v.l : Math.max(v.l, hold.l - HOLD_DECAY * dt);
      hold.r = v.r > hold.r ? v.r : Math.max(v.r, hold.r - HOLD_DECAY * dt);
      if (lRef.current) lRef.current.style.height = `${(v.l * 100).toFixed(1)}%`;
      if (rRef.current) rRef.current.style.height = `${(v.r * 100).toFixed(1)}%`;
      if (lHold.current) lHold.current.style.bottom = `${(hold.l * 100).toFixed(1)}%`;
      if (rHold.current) rHold.current.style.bottom = `${(hold.r * 100).toFixed(1)}%`;
      root.current?.classList.toggle("clip", (lv?.l ?? -100) > 0 || (lv?.r ?? -100) > 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [trackId]);

  return (
    <div className="meter" ref={root} aria-hidden="true">
      <span className="meter-ch"><i className="meter-bar" ref={lRef} /><i className="meter-hold" ref={lHold} /></span>
      <span className="meter-ch"><i className="meter-bar" ref={rRef} /><i className="meter-hold" ref={rHold} /></span>
    </div>
  );
}

export function Meter({ trackId }: { trackId: string }) {
  return <MeterBars trackId={trackId} />;
}
export function MasterMeter() {
  return <MeterBars trackId={null} />;
}
