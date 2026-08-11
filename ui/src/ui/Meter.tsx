import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import { sendLevelKey } from "../types";
import { meterPct, isClip } from "./meterGeom";

// Live peak meters fed by the 30 Hz `levels` telemetry (NOT the snapshot). The level
// is read imperatively inside a requestAnimationFrame loop and written straight to the
// bar DOM, so the meter never re-renders React on the hot path — same discipline as the
// Moshi spectrum loop. Geometry comes from the pure meter.ts mapping (unit-tested);
// ballistics (instant attack, eased decay, brief clip latch) live here.

type Level = { l: number; r: number };
type ReadLevel = () => Level | undefined;
type BarsProps = {
  readonly read: ReadLevel;
  readonly className?: string;
  readonly label?: string;
};

function Bars({ read, className, label }: BarsProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const lMask = useRef<HTMLElement>(null);
  const rMask = useRef<HTMLElement>(null);

  useEffect(() => {
    let raf = 0;
    let prev = 0;
    let lPct = 0;
    let rPct = 0;
    let clipUntil = 0;
    const DECAY = 90; // %/sec the bar falls after a peak

    // The gradient lives on the track; a right-anchored mask hides the unlit part, so
    // a smaller mask = a fuller bar.
    const paint = (mask: HTMLElement | null, pct: number) => {
      if (mask) mask.style.width = (100 - pct).toFixed(1) + "%";
    };

    const tick = (t: number) => {
      const dt = prev ? Math.min(0.1, (t - prev) / 1000) : 0;
      prev = t;
      const v = read() ?? { l: -100, r: -100 };
      const tl = meterPct(v.l);
      const tr = meterPct(v.r);
      lPct = tl >= lPct ? tl : Math.max(tl, lPct - DECAY * dt);
      rPct = tr >= rPct ? tr : Math.max(tr, rPct - DECAY * dt);
      if (isClip(v.l) || isClip(v.r)) clipUntil = t + 900;
      paint(lMask.current, lPct);
      paint(rMask.current, rPct);
      wrap.current?.classList.toggle("meter-clip", t < clipUntil);
      if (label && wrap.current) {
        const l = Math.max(-100, Math.min(0, Number.isFinite(v.l) ? v.l : -100));
        const r = Math.max(-100, Math.min(0, Number.isFinite(v.r) ? v.r : -100));
        wrap.current.setAttribute("aria-valuenow", String(Math.max(l, r)));
        wrap.current.setAttribute(
          "aria-valuetext",
          `Left ${l.toFixed(1)} dBFS, right ${r.toFixed(1)} dBFS`,
        );
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [read]);

  return (
    <div className={`meter${className ? " " + className : ""}`} ref={wrap}
      aria-hidden={label ? undefined : true}
      role={label ? "meter" : undefined}
      aria-label={label}
      aria-valuemin={label ? -100 : undefined}
      aria-valuemax={label ? 0 : undefined}
      aria-valuenow={label ? -100 : undefined}
      aria-valuetext={label ? "Left -100.0 dBFS, right -100.0 dBFS" : undefined}>
      <span className="mbar"><i className="mmask" ref={lMask} /></span>
      <span className="mbar"><i className="mmask" ref={rMask} /></span>
    </div>
  );
}

// Per-track peak meter — reads this track's slot from the live `levels` telemetry.
export function Meter({ trackId }: { trackId: string }) {
  const read = useCallback<ReadLevel>(() => useStore.getState().levels.tracks[trackId], [trackId]);
  return <Bars read={read} />;
}

// Master-bus peak meter (topbar).
export function MasterMeter() {
  const read = useCallback<ReadLevel>(() => useStore.getState().levels.master, []);
  return <Bars read={read} className="master" />;
}

export function SendMeter({ trackId, bus, label }: {
  readonly trackId: string;
  readonly bus: number;
  readonly label: string;
}) {
  const key = sendLevelKey(trackId, bus);
  const read = useCallback<ReadLevel>(() => useStore.getState().sendLevels[key], [key]);
  return <Bars read={read} className="send" label={label} />;
}
