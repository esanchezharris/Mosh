// Parameter-automation editor (the buried panel — opened from a small ⌁ button in
// the track's chain, not the main toolbar). A plugin+param picker chooses which
// AutomatableParameter to draw; points are seconds × normalised value. Every edit
// is a command: add/set/remove_automation_point, clear_automation. The read-only
// inline lanes from the legacy UI are intentionally dropped (keeps the arrangement
// clean — automation lives only in this modal).

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import type { AutoPoint, PluginParam } from "../types";

const H = 220;
const PAD = 12;

// A DISCRETE parameter (the CAP-AUT-006 mute gate is the first one) has no meaning
// between its states: the engine runs every applied value through snapToState, so a
// point drawn at 0.37 is applied as 0. Snap on the way in so the dot sits where the
// audio actually is, rather than at a value nothing will ever use.
export function snapParamValue(param: PluginParam | null, v: number): number {
  const states = param?.discrete ? Math.max(2, param.states ?? 2) : 0;
  if (!states) return v;
  return Math.round(v * (states - 1)) / (states - 1);
}

export function AutomationPanel() {
  const trackId = useStore((s) => s.automationTrackId);
  const close = useStore((s) => s.closeAutomation);
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);

  const track = snapshot?.tracks.find((t) => t.id === trackId) ?? null;
  // CAP-AUT-006 — the mixer strip's automatable plugins (fader, mute gate) are hidden
  // from the rack but are ordinary automation targets: same pluginIndex/paramIndex
  // addressing, so they just join the picker list. They go LAST so a track that has real
  // plugins still defaults to the first of those, unchanged; a track with none now
  // defaults to the mixer instead of showing "no plugins" over an empty canvas.
  const plugins = useMemo(
    () => [...(track?.plugins ?? []), ...(track?.mixerPlugins ?? [])],
    [track?.plugins, track?.mixerPlugins],
  );

  const [pluginIndex, setPluginIndex] = useState<number | null>(null);
  const [paramIndex, setParamIndex] = useState(0);
  const [preview, setPreview] = useState<{ i: number; t: number; v: number } | null>(null);
  const dragRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!track) return;
    if (pluginIndex == null || !plugins.some((p) => p.index === pluginIndex)) {
      setPluginIndex(plugins[0] ? plugins[0].index : null); setParamIndex(0);
    }
  }, [track, plugins, pluginIndex]);
  useEffect(() => { if (trackId && !track) close(); }, [trackId, track, close]);
  useEscapeToClose(!!trackId, close); // Esc dismisses, like the other modals
  // Move focus into the dialog on open so aria-modal is honest (the outside is inert)
  // and keyboard users land inside, not on the trigger button behind the backdrop.
  useEffect(() => { if (trackId) panelRef.current?.focus(); }, [trackId]);

  if (!trackId || !track) return null;

  const plugin = plugins.find((p) => p.index === pluginIndex) ?? null;
  const param = plugin?.params?.find((p) => p.index === paramIndex) ?? plugin?.params?.[0] ?? null;
  const points: AutoPoint[] = (param?.points ?? []).slice().sort((a, b) => a.t - b.t);

  const lengthSec = Math.max(16, snapshot?.session.length ?? 16);
  const W = lengthSec * pxPerSec;
  const xOf = (t: number) => t * pxPerSec;
  const yOf = (v: number) => PAD + (1 - v) * (H - 2 * PAD);
  const tOf = (x: number) => Math.max(0, x / pxPerSec);
  const vOf = (y: number) => Math.min(1, Math.max(0, 1 - (y - PAD) / (H - 2 * PAD)));
  const target = { trackId: track.id, pluginIndex, paramIndex };

  const addAt = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget || !param) return;
    const rect = e.currentTarget.getBoundingClientRect();
    void exec("add_automation_point", {
      ...target,
      time: tOf(e.clientX - rect.left),
      value: snapParamValue(param, vOf(e.clientY - rect.top)),
    });
  };
  const onDotDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = i;
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragRef.current == null || e.buttons === 0) return;
    const svg = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
    setPreview({ i: dragRef.current, t: tOf(e.clientX - svg.left), v: snapParamValue(param, vOf(e.clientY - svg.top)) });
  };
  const onUp = () => {
    const i = dragRef.current; dragRef.current = null;
    if (i == null || !preview) return;
    void exec("set_automation_point", { ...target, pointIndex: i, time: preview.t, value: preview.v });
    setPreview(null);
  };
  const onCancel = () => { dragRef.current = null; setPreview(null); };

  const display = points.map((p, i) => (preview && preview.i === i ? { t: preview.t, v: preview.v } : p));
  const sorted = display.map((p, i) => ({ ...p, i })).sort((a, b) => a.t - b.t);
  // A two-state parameter does not fade between its points — the engine snaps the
  // interpolated value at 0.5, which a 0->1 segment crosses exactly halfway along. Draw
  // that: a step at the midpoint is the true applied shape, a diagonal would promise a
  // fade the audio never performs. (>2 states falls back to the straight line; the mute
  // gate is the only discrete parameter today and it has exactly two.)
  const stepped = !!param?.discrete && (param.states ?? 2) === 2;
  const path = stepped
    ? sorted
        .map((p, k) => {
          const move = `${k === 0 ? "M" : "L"} ${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`;
          const next = sorted[k + 1];
          if (!next || next.v === p.v) return move;
          const midX = xOf((p.t + next.t) / 2).toFixed(1);
          return `${move} L ${midX} ${yOf(p.v).toFixed(1)} L ${midX} ${yOf(next.v).toFixed(1)}`;
        })
        .join(" ")
    : sorted.map((p, k) => `${k === 0 ? "M" : "L"} ${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`).join(" ");

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="auto-panel" data-testid="automation-panel" role="dialog" aria-modal="true"
        ref={panelRef} tabIndex={-1} style={{ outline: "none" }}
        aria-label={`Automation · ${track.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="auto-head">
          <strong className="display">Automation · {track.name}</strong>
          <select className="btn ghost" value={pluginIndex ?? ""} onChange={(e) => { setPluginIndex(Number(e.target.value)); setParamIndex(0); }}>
            {plugins.length === 0 && <option value="">no plugins</option>}
            {plugins.map((p) => <option key={p.index} value={p.index}>{p.name}</option>)}
          </select>
          <select className="btn ghost" value={paramIndex} onChange={(e) => setParamIndex(Number(e.target.value))}>
            {(plugin?.params ?? []).map((pr) => <option key={pr.index} value={pr.index}>{pr.name}{pr.automated ? " ●" : ""}</option>)}
          </select>
          <span className="spacer" />
          {/* G10 — record-arm mode is per-TRACK (every param on the track captures while
              write-armed), not per-param — hence no dependency on the plugin/param pickers. */}
          <select
            className="btn ghost"
            title="Automation record mode (arms the whole track, not just this parameter)"
            value={track.automationMode ?? "read"}
            onChange={(e) => void exec("set_track_automation_mode", { trackId: track.id, mode: e.target.value })}
          >
            <option value="read">Read</option>
            {/* G10 — Touch and Latch are ACCEPTED by set_track_automation_mode but are
                inert in the engine (see the "touch/latch are accepted … but inert here in
                v0" note beside cmdSetTrackAutomationMode). Offering them as live choices
                meant picking one silently did nothing: the user arms Touch, moves a
                fader, records nothing, and has no way to tell that from a bug. Disabled
                and labelled until the engine implements them — an honest gap beats a
                convincing no-op. */}
            <option value="touch" disabled>Touch (not yet)</option>
            <option value="latch" disabled>Latch (not yet)</option>
            <option value="write">Write</option>
          </select>
          <button className="btn" onClick={() => exec("clear_automation", target)} disabled={points.length === 0}>Clear</button>
          <button className="btn x" onClick={close}>✕</button>
        </div>
        <div className="auto-scroll">
          <svg className="auto-canvas" width={W} height={H} onPointerDown={addAt} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onLostPointerCapture={onCancel}>
            {[0, 0.25, 0.5, 0.75, 1].map((v) => <line key={v} x1={0} x2={W} y1={yOf(v)} y2={yOf(v)} className={`auto-grid${v === 0.5 ? " mid" : ""}`} />)}
            {points.length >= 2 && <path d={path} className="auto-line" fill="none" />}
            {points.map((p, i) => {
              const pt = preview && preview.i === i ? preview : p;
              return (
                <circle key={i} cx={xOf(pt.t)} cy={yOf(pt.v)} r={5} className="auto-dot" data-testid="auto-dot"
                  onPointerDown={onDotDown(i)} onPointerMove={onMove} onPointerUp={onUp}
                  onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); void exec("remove_automation_point", { ...target, pointIndex: i }); }} />
              );
            })}
          </svg>
        </div>
        <div className="auto-foot">
          {plugin ? "click to add a point · drag to move · double-click to remove · value 0–1 (top = max)" : "load a plugin on this track to automate its parameters"}
        </div>
      </div>
    </div>
  );
}
