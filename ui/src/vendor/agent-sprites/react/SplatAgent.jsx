import { createEngine, drawCanvas } from "../index.esm.js";
import { useEffect, useRef } from "react";

export function SplatAgent({
  colorway = "encre",
  state = "idle",
  seed = 0,
  size = 64,
  className,
  style,
  onClick,
  title,
  reducedMotion,
}) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const lastRef = useRef({ colorway, state });
  const propsRef = useRef({ colorway, state, size, reducedMotion });
  propsRef.current = { colorway, state, size, reducedMotion };

  if (!engineRef.current) {
    engineRef.current = createEngine({ colorway, state, seed });
    lastRef.current = { colorway, state };
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (!canvas || !engine) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    canvas.width = size;
    canvas.height = size;

    const origin = performance.now() / 1000;
    let raf = 0;
    let stopped = false;

    function paint(nowMs) {
      const p = propsRef.current;
      const t = nowMs / 1000 - origin;
      const last = lastRef.current;

      if (last.state !== p.state) {
        engine.setState(p.state, t);
        last.state = p.state;
      }
      if (last.colorway !== p.colorway) {
        engine.setColorway(p.colorway);
        last.colorway = p.colorway;
      }

      const frame = engine.sample(t);
      ctx.clearRect(0, 0, p.size, p.size);
      drawCanvas(ctx, frame, {
        size: p.size,
        paper: "transparent",
        flat: true,
        shadow: false,
        pad: 0.28,
      });

      if (!p.reducedMotion && !stopped) {
        raf = requestAnimationFrame(paint);
      }
    }

    if (reducedMotion) {
      paint(performance.now());
    } else {
      raf = requestAnimationFrame(paint);
    }

    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [size, reducedMotion, seed]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={className}
      title={title}
      onClick={onClick}
      style={{
        display: "block",
        width: size,
        height: size,
        background: "transparent",
        ...style,
      }}
    />
  );
}

export default SplatAgent;
