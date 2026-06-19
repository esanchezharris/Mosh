// Generic floating window (Phase 6): a draggable (title-bar) + resizable
// (bottom-right handle) panel positioned over the workspace. Geometry is owned by
// the caller (a useFloatingWindow-style store delegating to the pure engine); this
// component just translates pointer drags into onMove/onResize deltas.

import { useRef, type ReactNode } from "react";
import type { FloatWin, ResizeEdge } from "./dockLayout";

export function FloatingWindow({
  win, title, onMove, onResize, onClose, children,
}: {
  win: FloatWin;
  title: string;
  onMove: (dx: number, dy: number) => void;
  onResize: (edge: ResizeEdge, dx: number, dy: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const mode = useRef<"move" | ResizeEdge | null>(null);

  const begin = (m: "move" | ResizeEdge) => (e: React.PointerEvent) => {
    e.stopPropagation();
    last.current = { x: e.clientX, y: e.clientY };
    mode.current = m;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const drag = (e: React.PointerEvent) => {
    if (!last.current || !mode.current) return;
    const dx = e.clientX - last.current.x, dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    if (dx === 0 && dy === 0) return;
    if (mode.current === "move") onMove(dx, dy);
    else onResize(mode.current, dx, dy);
  };
  const end = (e: React.PointerEvent) => {
    last.current = null; mode.current = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  return (
    <div className="floatwin" data-testid="floating-window" role="dialog" aria-label={title}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h }}>
      <div className="floatwin-bar" data-testid="floatwin-bar"
        onPointerDown={begin("move")} onPointerMove={drag} onPointerUp={end}>
        <span className="floatwin-title display">{title}</span>
        {/* Stop the pointerdown bubbling to the title-bar's begin("move") — otherwise the
            bar captures the pointer and the close click is swallowed (the window won't
            close, or a stray drag fires instead). */}
        <button className="btn x" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}
          aria-label="Close window" title="Close">✕</button>
      </div>
      <div className="floatwin-body">{children}</div>
      <div className="floatwin-resize" data-testid="floatwin-resize" title="Resize"
        onPointerDown={begin("se")} onPointerMove={drag} onPointerUp={end} />
    </div>
  );
}
