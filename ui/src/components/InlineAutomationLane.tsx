import { useStore } from "../store";
import type { AutoPoint, Track } from "../types";

// AUT-003 — read-only inline automation strip rendered inside each Arrangement
// lane (under the clips). It uses the same draw math as AutomationPanel and the
// same pxPerSec mapping as the ruler so points line up with clips. Editing stays
// in the explicit AutomationPanel; the inline strip must not create automation
// from ordinary arrangement clicks.
export function InlineAutomationLane({ track, width, height }: { track: Track; width: number; height: number }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
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

  // Same draw math as AutomationPanel, scaled to this lane's height. A small pad
  // keeps the top/bottom dots reachable inside the thin strip.
  const PAD = Math.min(6, Math.max(2, height * 0.12));
  const xOf = (t: number) => t * pxPerSec;
  const yOf = (v: number) => PAD + (1 - v) * (height - 2 * PAD);

  if (pluginIndex == null || !param) return null;

  const sorted = points.map((p, i) => ({ ...p, i })).sort((a, b) => a.t - b.t);
  const path = sorted.map((p, k) => `${k === 0 ? "M" : "L"} ${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`).join(" ");

  return (
    <svg
      className="inline-auto"
      role="img"
      aria-label={`Automation lane ${track.name || `Track ${track.index + 1}`} read-only`}
      width={width}
      height={height}
    >
      <line x1={0} x2={width} y1={yOf(0.5)} y2={yOf(0.5)} className="auto-grid mid" />
      {points.length >= 2 && <path d={path} className="auto-line" fill="none" />}
      {points.map((p, i) => {
        return (
          <circle
            key={i}
            cx={xOf(p.t)} cy={yOf(p.v)} r={4}
            className="auto-dot"
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
