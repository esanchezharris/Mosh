import { useEffect, useRef } from "react";
import { useStore, type Peaks } from "../store";
import { beatSeconds, meterFrom } from "../time";
import type { Snapshot, Track } from "../types";
import { classifyLane, drumVoiceForPitch, visibleLaneClips, type LaneSurfaceKind } from "./laneSurfaceModel";
import type { VisibleRange } from "./timelineGeometry";

const DRUM_ROWS = ["KICK", "SNARE", "HI-HAT", "PERC"] as const;

type SurfaceProps = {
  readonly track: Track;
  readonly snapshot: Snapshot;
  readonly range: VisibleRange;
  readonly hue: string;
  readonly expanded: boolean;
};

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, columns: number, rows: number) {
  ctx.strokeStyle = "rgba(255,255,255,.055)";
  ctx.lineWidth = 1;
  for (let column = 0; column <= columns; column++) {
    const x = Math.round((column / columns) * width) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let row = 1; row < rows; row++) {
    const y = Math.round((row / rows) * height) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
}

function drawDrums(ctx: CanvasRenderingContext2D, props: SurfaceProps, width: number, height: number) {
  const rows = props.expanded ? 4 : 2;
  const steps = props.expanded ? 16 : 32;
  drawGrid(ctx, width, height, steps, rows);
  const secondsPerBeat = beatSeconds(meterFrom(props.snapshot.session));
  for (const { clip } of visibleLaneClips(props.track.clips, props.range)) {
    for (const note of clip.notes ?? []) {
      const second = clip.start + note.start * secondsPerBeat;
      if (second < props.range.startSec || second > props.range.endSec) continue;
      const voice = drumVoiceForPitch(note.pitch);
      const voiceIndex = DRUM_ROWS.indexOf(voice);
      const row = props.expanded ? voiceIndex : Math.min(1, Math.floor(voiceIndex / 2));
      const x = ((second - props.range.startSec) / props.range.spanSec) * width;
      const cellWidth = Math.max(3, width / steps - 3);
      const rowHeight = height / rows;
      ctx.globalAlpha = 0.58 + note.velocity / 320;
      ctx.fillStyle = props.hue;
      ctx.fillRect(Math.round(x) + 1, row * rowHeight + rowHeight * 0.22, cellWidth, rowHeight * 0.56);
    }
  }
  ctx.globalAlpha = 1;
}

function drawMidi(ctx: CanvasRenderingContext2D, props: SurfaceProps, width: number, height: number) {
  const rows = props.expanded ? 12 : 6;
  drawGrid(ctx, width, height, props.expanded ? 16 : 8, rows);
  const secondsPerBeat = beatSeconds(meterFrom(props.snapshot.session));
  const notes = visibleLaneClips(props.track.clips, props.range).flatMap(({ clip }) =>
    (clip.notes ?? []).map((note) => ({ clip, note })),
  );
  const pitches = notes.map(({ note }) => note.pitch);
  const low = pitches.length > 0 ? Math.min(...pitches) : 48;
  const high = pitches.length > 0 ? Math.max(...pitches) : 72;
  const pitchSpan = Math.max(11, high - low + 1);
  for (const { clip, note } of notes) {
    const startSec = clip.start + note.start * secondsPerBeat;
    const endSec = startSec + note.length * secondsPerBeat;
    const clippedStart = Math.max(props.range.startSec, startSec);
    const clippedEnd = Math.min(props.range.endSec, endSec);
    if (clippedEnd <= clippedStart) continue;
    const x = ((clippedStart - props.range.startSec) / props.range.spanSec) * width;
    const noteWidth = Math.max(2, ((clippedEnd - clippedStart) / props.range.spanSec) * width);
    const y = (1 - (note.pitch - low + 0.5) / pitchSpan) * height;
    ctx.globalAlpha = 0.48 + note.velocity / 300;
    ctx.fillStyle = props.hue;
    ctx.fillRect(x, y, noteWidth, Math.max(2, height / rows - 2));
  }
  ctx.globalAlpha = 1;
}

function drawWave(ctx: CanvasRenderingContext2D, props: SurfaceProps, peaks: Record<string, Peaks>, width: number, height: number) {
  ctx.strokeStyle = "rgba(255,255,255,.045)";
  ctx.beginPath(); ctx.moveTo(0, height / 2 + 0.5); ctx.lineTo(width, height / 2 + 0.5); ctx.stroke();
  for (const { clip, rect } of visibleLaneClips(props.track.clips, props.range)) {
    const values = peaks[clip.id];
    const left = rect.leftFrac * width;
    const clipWidth = Math.max(2, rect.widthFrac * width);
    if (!values || values.length === 0) {
      ctx.fillStyle = `${props.hue}22`;
      ctx.fillRect(left, height * 0.44, clipWidth, height * 0.12);
      continue;
    }
    ctx.strokeStyle = props.hue;
    ctx.globalAlpha = props.expanded ? 0.9 : 0.72;
    ctx.beginPath();
    for (let x = 0; x < clipWidth; x += 1) {
      const peak = values[Math.min(values.length - 1, Math.floor((x / clipWidth) * values.length))];
      const top = height / 2 - Math.abs(peak?.[1] ?? 0) * height * 0.42;
      const bottom = height / 2 + Math.abs(peak?.[0] ?? 0) * height * 0.42;
      ctx.moveTo(left + x + 0.5, top); ctx.lineTo(left + x + 0.5, bottom);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function SurfaceCanvas(props: SurfaceProps & { readonly kind: LaneSurfaceKind }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaks = useStore((state) => state.peaks);
  const ensurePeaks = useStore((state) => state.ensurePeaks);

  useEffect(() => {
    if (props.kind !== "wave") return;
    for (const { clip } of visibleLaneClips(props.track.clips, props.range)) {
      if (clip.type === "wave" && !peaks[clip.id]) ensurePeaks(clip.id);
    }
  }, [ensurePeaks, peaks, props.kind, props.range, props.track.clips]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const draw = () => {
      const width = parent.clientWidth, height = parent.clientHeight;
      if (width <= 0 || height <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      if (props.kind === "drum") drawDrums(ctx, props, width, height);
      else if (props.kind === "midi") drawMidi(ctx, props, width, height);
      else drawWave(ctx, props, peaks, width, height);
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(parent);
    return () => observer.disconnect();
  }, [peaks, props]);

  return <canvas ref={canvasRef} data-testid={`v3-lane-canvas-${props.track.id}`} />;
}

export function LaneSurface(props: SurfaceProps) {
  const kind = classifyLane(props.track);
  return (
    <div className="ol-surface" data-kind={kind} data-expanded={props.expanded}>
      {kind === "drum" && props.expanded && (
        <div className="ol-drum-labels" aria-hidden>{DRUM_ROWS.map((label) => <span key={label}>{label}</span>)}</div>
      )}
      <div className="ol-surface-content" data-lane-content={props.track.id}>
        <SurfaceCanvas {...props} kind={kind} />
      </div>
    </div>
  );
}
