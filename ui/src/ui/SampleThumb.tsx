import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

type Peak = [number, number];

function peaksFrom(value: unknown): Peak[] | null {
  if (typeof value !== "object" || value === null || !("peaks" in value)
    || !Array.isArray(value.peaks)) return null;
  const peaks: Peak[] = [];
  for (const peak of value.peaks) {
    if (!Array.isArray(peak) || peak.length !== 2
      || typeof peak[0] !== "number" || typeof peak[1] !== "number") return null;
    peaks.push([peak[0], peak[1]]);
  }
  return peaks;
}

export function SampleThumb({ path }: { path: string }) {
  const exec = useStore((s) => s.exec);
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Peak[] | null>(null);
  useEffect(() => {
    let active = true;
    void exec("file_peaks", { path, buckets: 60 }).then((result) => {
      const next = result.ok ? peaksFrom(result.data) : null;
      if (active && next) setPeaks(next);
    });
    return () => { active = false; };
  }, [path, exec]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const midpoint = canvas.height / 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = getComputedStyle(canvas).color || "#ccff23";
    const barWidth = canvas.width / Math.max(1, peaks.length);
    peaks.forEach((peak, index) => {
      const top = midpoint - peak[1] * midpoint;
      const bottom = midpoint - peak[0] * midpoint;
      context.fillRect(index * barWidth, top, Math.max(1, barWidth - 0.5), Math.max(1, bottom - top));
    });
  }, [peaks]);
  return <canvas ref={ref} className="sb-thumb" width={56} height={22} aria-hidden="true" />;
}
