import { useEffect, useRef } from "react";
import type { Note } from "../types";

// Note blocks on a canvas — the MIDI sibling of <Waveform> (Stage 14). Pitch
// is normalized to the clip's own range, velocity shades opacity. Read-only:
// editing happens in the drum rack / future piano roll, never here.
export function MidiNotePreview({
  notes,
  lengthBeats,
  width,
  height,
  color = "rgba(255,255,255,0.92)",
}: {
  notes: Note[];
  lengthBeats: number;
  width: number;
  height: number;
  color?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    if (!notes.length || lengthBeats <= 0) return;

    let lo = Math.min(...notes.map((n) => n.pitch));
    let hi = Math.max(...notes.map((n) => n.pitch));
    if (hi - lo < 7) {
      // Keep single-pitch lanes from filling the clip — center a small span.
      const mid = (hi + lo) / 2;
      lo = mid - 4;
      hi = mid + 4;
    }
    const span = hi - lo + 1;
    const rowH = Math.max(2, Math.min(8, height / span));

    for (const n of notes) {
      const x = (n.startBeats / lengthBeats) * width;
      const w = Math.max(2, (n.durBeats / lengthBeats) * width - 1);
      const y = height - ((n.pitch - lo + 1) / span) * height;
      ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, n.vel / 127);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, rowH);
    }
    ctx.globalAlpha = 1;
  }, [notes, lengthBeats, width, height, color]);

  return <canvas ref={ref} style={{ width, height }} />;
}
