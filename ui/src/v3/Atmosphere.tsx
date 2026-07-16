import { useEffect, useRef } from "react";
import { useStore } from "../store";

type Size = { width: number; height: number };

function paint(ctx: CanvasRenderingContext2D, size: Size, time: number, reduced: boolean) {
  const state = useStore.getState();
  const energy = state.transport.playing ? 0.45 + Math.min(0.35, state.spectrum.level * 0.35) : 0.18;
  const drift = reduced ? 0 : time * 0.000035;
  ctx.clearRect(0, 0, size.width, size.height);

  const halo = ctx.createRadialGradient(
    size.width * (0.44 + Math.sin(drift) * 0.08), size.height * 0.18, 0,
    size.width * 0.5, size.height * 0.25, size.width * 0.58,
  );
  halo.addColorStop(0, `rgba(125,139,172,${0.07 + energy * 0.05})`);
  halo.addColorStop(0.5, "rgba(65,72,92,.028)");
  halo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = halo; ctx.fillRect(0, 0, size.width, size.height);

  const floor = ctx.createRadialGradient(size.width * 0.52, size.height * 1.08, 0, size.width * 0.5, size.height, size.width * 0.52);
  floor.addColorStop(0, `rgba(204,255,54,${0.012 + energy * 0.012})`);
  floor.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = floor; ctx.fillRect(0, 0, size.width, size.height);

  for (let index = 0; index < 42; index++) {
    const seed = (index * 16807) % 2147483647;
    const x = ((seed % 997) / 997 * size.width + drift * (8 + index % 7)) % size.width;
    const y = (((seed * 37) % 991) / 991) * size.height;
    ctx.fillStyle = `rgba(225,231,241,${0.025 + (index % 5) * 0.008})`;
    ctx.fillRect(x, y, index % 9 === 0 ? 1.5 : 1, index % 9 === 0 ? 1.5 : 1);
  }
}

export function Atmosphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const size: Size = { width: 0, height: 0 };
    let frame = 0, lastPaint = 0;
    const resize = (width: number, height: number) => {
      size.width = Math.max(1, Math.round(width / 2));
      size.height = Math.max(1, Math.round(height / 2));
      canvas.width = size.width; canvas.height = size.height;
      paint(ctx, size, 0, reduced);
    };
    const observer = new ResizeObserver(([entry]) => {
      if (entry) resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(canvas);
    const tick = (time: number) => {
      if (time - lastPaint > 33) { paint(ctx, size, time, false); lastPaint = time; }
      frame = requestAnimationFrame(tick);
    };
    if (!reduced) frame = requestAnimationFrame(tick);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  return <canvas ref={canvasRef} className="ol-atmosphere" aria-hidden="true" />;
}
