import { useRef, useState } from "react";
import { useStore } from "../store";
import type { AutoPoint, Track } from "../types";

// AUT-003 — inline automation strip rendered inside each Arrangement lane (under
// the clips). It reuses AutomationPanel's EXACT draw math (xOf/yOf/tOf/vOf) and
// the add/drag/remove pointer handlers, but laid out at the track's lane height
// and using the SAME pxPerSec mapping as the ruler so the points line up with
// the clips above. It mutates only through the existing add/set/remove
// automation commands — no new backend. Which AutomatableParameter is drawn is
// UI-local view state (store.inlineAuto[trackId]); the modal AutomationPanel
// remains the big editor.
export function InlineAutomationLane({ track, width, height }: { track: Track; width: number; height: number }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const exec = useStore((s) => s.exec);
  const inlineAuto = useStore((s) => s.inlineAuto);

  const plugins = track.plugins ?? [];
  const sel = inlineAuto[track.id];
  // Default to the volume plugin (param 0) when the track has no explicit choice.
  const vol = plugins.find((p) => p.type === "volume") ?? plugins[0];
  const pluginIndex = sel?.pluginIndex ?? vol?.index ?? null;
  const paramIndex = sel?.paramIndex ?? 0;

  const plugin = plugins.find((p) => p.index === pluginIndex) ?? null;
  const param = plugin?.params?.find((p) => p.index === paramIndex) ?? plugin?.params?.[0] ?? null;
  const points: AutoPoint[] = (param?.points ?? []).slice().sort((a, b) => a.t - b.t);

  const [preview, setPreview] = useState<{ i: number; t: number; v: number } | null>(null);
  const dragRef = useRef<number | null>(null);

  // Same draw math as AutomationPanel, scaled to this lane's height. A small pad
  // keeps the top/bottom dots reachable inside the thin strip.
  const PAD = Math.min(6, Math.max(2, height * 0.12));
  const xOf = (t: number) => t * pxPerSec;
  const yOf = (v: number) => PAD + (1 - v) * (height - 2 * PAD);
  const tOf = (x: number) => Math.max(0, x / pxPerSec);
  const vOf = (y: number) => Math.min(1, Math.max(0, 1 - (y - PAD) / (height - 2 * PAD)));

  if (pluginIndex == null || !param) return null;
  const target = { trackId: track.id, pluginIndex, paramIndex };

  const addAt = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    void exec("add_automation_point", { ...target, time: tOf(e.clientX - rect.left), value: vOf(e.clientY - rect.top) });
  };
  const onDotDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = i;
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragRef.current == null) return;
    const svg = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
    setPreview({ i: dragRef.current, t: tOf(e.clientX - svg.left), v: vOf(e.clientY - svg.top) });
  };
  const onUp = () => {
    const i = dragRef.current;
    dragRef.current = null;
    if (i == null || !preview) return;
    void exec("set_automation_point", { ...target, pointIndex: i, time: preview.t, value: preview.v });
    setPreview(null);
  };

  const display = points.map((p, i) => (preview && preview.i === i ? { t: preview.t, v: preview.v } : p));
  const sorted = display.map((p, i) => ({ ...p, i })).sort((a, b) => a.t - b.t);
  const path = sorted.map((p, k) => `${k === 0 ? "M" : "L"} ${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`).join(" ");

  return (
    <svg
      className="inline-auto"
      width={width}
      height={height}
      onPointerDown={addAt}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <line x1={0} x2={width} y1={yOf(0.5)} y2={yOf(0.5)} className="auto-grid mid" />
      {points.length >= 2 && <path d={path} className="auto-line" fill="none" />}
      {points.map((p, i) => {
        const pt = preview && preview.i === i ? preview : p;
        return (
          <circle
            key={i}
            cx={xOf(pt.t)} cy={yOf(pt.v)} r={4}
            className="auto-dot"
            onPointerDown={onDotDown(i)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onDoubleClick={(e) => { e.stopPropagation(); void exec("remove_automation_point", { ...target, pointIndex: i }); }}
          />
        );
      })}
    </svg>
  );
}

// Compact per-track param picker for the inline lane (which AutomatableParameter
// the strip draws). Reuses the panel's plugin/param dropdown shape but inline in
// the TrackHeader. Pure view state — never a command.
export function InlineAutoPicker({ track }: { track: Track }) {
  const inlineAuto = useStore((s) => s.inlineAuto);
  const setInlineAuto = useStore((s) => s.setInlineAuto);
  const plugins = track.plugins ?? [];
  if (plugins.length === 0) return null;

  const sel = inlineAuto[track.id];
  const vol = plugins.find((p) => p.type === "volume") ?? plugins[0];
  const pluginIndex = sel?.pluginIndex ?? vol?.index ?? plugins[0].index;
  const paramIndex = sel?.paramIndex ?? 0;
  const plugin = plugins.find((p) => p.index === pluginIndex) ?? plugins[0];

  return (
    <div className="ia-picker" onPointerDown={(e) => e.stopPropagation()}>
      <select
        className="ia-sel"
        value={pluginIndex}
        title="Inline-lane plugin"
        onChange={(e) => setInlineAuto(track.id, { pluginIndex: Number(e.target.value), paramIndex: 0 })}
      >
        {plugins.map((p) => (
          <option key={p.index} value={p.index}>{p.type === "volume" ? "Vol/Pan" : p.name}</option>
        ))}
      </select>
      <select
        className="ia-sel"
        value={paramIndex}
        title="Inline-lane parameter"
        onChange={(e) => setInlineAuto(track.id, { pluginIndex, paramIndex: Number(e.target.value) })}
      >
        {(plugin?.params ?? []).map((pr) => (
          <option key={pr.index} value={pr.index}>{pr.name}{pr.automated ? " ●" : ""}</option>
        ))}
      </select>
    </div>
  );
}
