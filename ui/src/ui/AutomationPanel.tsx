// Parameter-automation editor (the buried panel — opened from a small ⌁ button in
// the track's chain, not the main toolbar). A plugin+param picker chooses which
// AutomatableParameter to draw; points are seconds × normalised value. Every edit
// is a command: add/set/remove_automation_point, clear_automation. The read-only
// inline lanes from the legacy UI are intentionally dropped (keeps the arrangement
// clean — automation lives only in this modal).

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import type { AutoPoint } from "../types";

const H = 220;
const PAD = 12;

export function AutomationPanel() {
  const trackId = useStore((s) => s.automationTrackId);
  const close = useStore((s) => s.closeAutomation);
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);

  const track = snapshot?.tracks.find((t) => t.id === trackId) ?? null;
  const plugins = track?.plugins ?? [];

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
    void exec("add_automation_point", { ...target, time: tOf(e.clientX - rect.left), value: vOf(e.clientY - rect.top) });
  };
  const onDotDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = i;
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragRef.current == null || e.buttons === 0) return;
    const svg = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
    setPreview({ i: dragRef.current, t: tOf(e.clientX - svg.left), v: vOf(e.clientY - svg.top) });
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
  const path = sorted.map((p, k) => `${k === 0 ? "M" : "L"} ${xOf(p.t).toFixed(1)} ${yOf(p.v).toFixed(1)}`).join(" ");

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
            <option value="touch">Touch</option>
            <option value="latch">Latch</option>
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
