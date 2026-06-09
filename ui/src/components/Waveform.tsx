import { useEffect, useRef } from "react";
import type { Peaks } from "../store";

// Renders backend-computed peaks (no audio on the web thread, 03). The peak
// array spans the whole source file; we draw the slice [offset, offset+length].
export function Waveform({
  peaks,
  width,
  height,
  offsetFrac,
  lengthFrac,
  color,
}: {
  peaks: Peaks | undefined;
  width: number;
  height: number;
  offsetFrac: number; // 0..1 start within source
  lengthFrac: number; // 0..1 portion of source shown
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !peaks || peaks.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.floor(width * dpr));
    cv.height = Math.max(1, Math.floor(height * dpr));
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;

    const mid = height / 2;
    const start = Math.floor(offsetFrac * peaks.length);
    const span = Math.max(1, Math.floor(lengthFrac * peaks.length));
    for (let x = 0; x < width; x++) {
      const i = start + Math.floor((x / width) * span);
      const p = peaks[Math.min(peaks.length - 1, Math.max(0, i))];
      if (!p) continue;
      const top = mid - p[1] * mid * 0.92;
      const bot = mid - p[0] * mid * 0.92;
      ctx.fillRect(x, top, 1, Math.max(1, bot - top));
    }
  }, [peaks, width, height, offsetFrac, lengthFrac, color]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}
