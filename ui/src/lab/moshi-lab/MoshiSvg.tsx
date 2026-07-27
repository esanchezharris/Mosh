// Candidate A — the flat-sticker Moshi as pure SVG + TS springs. Zero deps: the MoshMark
// geometry drawn once, then a rAF loop maps the shared MoshiBrain pose straight onto DOM
// attributes (no React re-render per frame — same doctrine as the WebGL mount). This is
// the "he IS the logo" candidate: squash & stretch, lid-snap blinks, a parametric singing
// mouth, per-lobe goo wobble, gaze, and state postures — all from the shared brain.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  MoshiBrain, VIEW, LOBES, LOBE_R, CENTER, CENTER_R,
  RIM_LOBE_R, RIM_CENTER_R, EYE_L, EYE_R, EYE_STROKE,
  mouthPath, mouthShape, LIME, INK, BONE,
  type MoshiBody, type MoshiDriveKey, type MoshiStateName,
} from "./moshiModel";

export type MoshiSvgColors = { body?: string; rim?: string; face?: string; mouth?: string; throat?: string };

let glowId = 0; // unique filter ids per instance (several mounts share the document)

export const MoshiSvg = forwardRef<MoshiBody, {
  size?: number;
  colors?: MoshiSvgColors;
  interactive?: boolean; // click = poke
  brain?: MoshiBrain;    // optional external brain (candidate B's state machine owns it)
}>(({ size = 260, colors = {}, interactive = true, brain }, ref) => {
  const body = colors.body ?? INK;
  const rim = colors.rim ?? BONE;
  const face = colors.face ?? BONE;
  const mouth = colors.mouth ?? LIME;
  const throat = colors.throat ?? INK;

  const brainRef = useRef<MoshiBrain | null>(null);
  if (!brainRef.current) brainRef.current = brain ?? new MoshiBrain();

  const rootG = useRef<SVGGElement>(null);
  const faceG = useRef<SVGGElement>(null);
  const eyeLG = useRef<SVGGElement>(null);
  const eyeRG = useRef<SVGGElement>(null);
  const mouthP = useRef<SVGPathElement>(null);
  const throatE = useRef<SVGEllipseElement>(null);
  const auraG = useRef<SVGGElement>(null);
  const lobeRefs = useRef<(SVGCircleElement | null)[]>([]);
  const auraLobeRefs = useRef<(SVGCircleElement | null)[]>([]);
  const filterIdRef = useRef(`moshi-glow-${++glowId}`);
  const cpu = useRef(0);

  useImperativeHandle(ref, (): MoshiBody => ({
    set(key: MoshiDriveKey, v: number) { brainRef.current?.set(key, v); },
    setState(s: MoshiStateName) { brainRef.current?.setState(s); },
    poke() { brainRef.current?.poke(); },
    celebrate() { brainRef.current?.celebrate(); },
    lookAt(nx: number, ny: number) { brainRef.current?.lookAt(nx, ny); },
    speak(on: boolean) { brainRef.current?.speak(on); },
    cpuMs() { return cpu.current; },
    destroy() { /* the rAF cleanup below owns teardown */ },
  }), []);

  useEffect(() => {
    const brain = brainRef.current!;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const t0 = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = brain.tick(dt);

      if (rootG.current) {
        rootG.current.setAttribute(
          "transform",
          `translate(50 ${50 + p.y}) rotate(${(p.rot * 57.3).toFixed(2)}) ` +
          `scale(${p.sx.toFixed(4)} ${p.sy.toFixed(4)}) translate(-50 -50)`,
        );
      }
      for (let i = 0; i < LOBES.length; i++) {
        const r = LOBE_R * p.lobes[i];
        lobeRefs.current[i]?.setAttribute("r", r.toFixed(2));
        auraLobeRefs.current[i]?.setAttribute("r", r.toFixed(2));
      }
      if (faceG.current) {
        faceG.current.setAttribute(
          "transform",
          `translate(${(p.gazeX * 3.4).toFixed(2)} ${(p.gazeY * 2.4).toFixed(2)})`,
        );
      }
      const k = Math.max(0.04, 1 - p.blink);
      if (eyeLG.current) eyeLG.current.setAttribute("transform", `translate(41 47.5) scale(1 ${k.toFixed(3)}) translate(-41 -47.5)`);
      if (eyeRG.current) eyeRG.current.setAttribute("transform", `translate(59 47.5) scale(1 ${k.toFixed(3)}) translate(-59 -47.5)`);
      const m = mouthShape(p.mouthOpen, p.mouthWide, p.smile);
      if (mouthP.current) mouthP.current.setAttribute("d", mouthPath(m));
      if (throatE.current) {
        throatE.current.setAttribute("cx", m.cx.toFixed(2));
        throatE.current.setAttribute("cy", (m.cy + m.depth * 0.66).toFixed(2));
        throatE.current.setAttribute("rx", m.throatRx.toFixed(2));
        throatE.current.setAttribute("ry", m.throatRy.toFixed(2));
        throatE.current.setAttribute("opacity", m.throatOpacity.toFixed(2));
      }
      if (auraG.current) auraG.current.setAttribute("opacity", (p.heat * 0.85).toFixed(3));

      cpu.current += (performance.now() - t0 - cpu.current) * 0.05;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const poly = (pts: readonly (readonly [number, number])[]) =>
    pts.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`}
      role="img" aria-label="Moshi — SVG springs candidate"
      style={{ cursor: interactive ? "pointer" : "default", display: "block" }}
      onClick={interactive ? () => brainRef.current?.poke() : undefined}
    >
      <defs>
        <filter id={filterIdRef.current} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
      </defs>
      <g ref={rootG}>
        {/* heat aura — the silhouette in lime, blurred, behind everything */}
        <g ref={auraG} opacity="0" filter={`url(#${filterIdRef.current})`} fill={mouth}>
          {LOBES.map(([cx, cy], i) => (
            <circle key={i} ref={(el) => { auraLobeRefs.current[i] = el; }} cx={cx} cy={cy} r={LOBE_R} />
          ))}
          <circle cx={CENTER[0]} cy={CENTER[1]} r={CENTER_R} />
        </g>
        {/* sticker rim */}
        <g fill={rim} opacity="0.9">
          {LOBES.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={RIM_LOBE_R} />)}
          <circle cx={CENTER[0]} cy={CENTER[1]} r={RIM_CENTER_R} />
        </g>
        {/* body — wobbling lobes + center */}
        <g fill={body}>
          {LOBES.map(([cx, cy], i) => (
            <circle key={i} ref={(el) => { lobeRefs.current[i] = el; }} cx={cx} cy={cy} r={LOBE_R} />
          ))}
          <circle cx={CENTER[0]} cy={CENTER[1]} r={CENTER_R} />
        </g>
        {/* face — gazes as one group */}
        <g ref={faceG}>
          <g ref={eyeLG} fill="none" stroke={face} strokeWidth={EYE_STROKE} strokeLinecap="round" strokeLinejoin="round">
            <polyline points={poly(EYE_L)} />
          </g>
          <g ref={eyeRG} fill="none" stroke={face} strokeWidth={EYE_STROKE} strokeLinecap="round" strokeLinejoin="round">
            <polyline points={poly(EYE_R)} />
          </g>
          <path ref={mouthP} d={mouthPath(mouthShape(0.06, 0.5, 0.6))} fill={mouth} />
          <ellipse ref={throatE} cx="50" cy="64" rx="0.01" ry="0.01" fill={throat} opacity="0" />
        </g>
      </g>
    </svg>
  );
});
MoshiSvg.displayName = "MoshiSvg";
