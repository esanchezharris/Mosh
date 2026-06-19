// Dock shell (Phase 6) — the fixed-zone layout for the arrange view: the main area
// (Arrange) fills, and the bottom detail panel (Dock) is RESIZABLE via a draggable
// divider and COLLAPSIBLE (double-click the divider, or the bar's button). Height is
// UI-local + persisted (useDockLayout); all geometry is the pure dockLayout engine.
// Floating-window mode + a left browser zone are later increments.

import { useRef, type ReactNode } from "react";
import { useDockLayout } from "./useDockLayout";

export function DockShell({ children, bottom }: { children: ReactNode; bottom: ReactNode }) {
  const zone = useDockLayout((s) => s.bottom);
  const resizeBottom = useDockLayout((s) => s.resizeBottom);
  const toggleBottom = useDockLayout((s) => s.toggleBottom);
  const dragY = useRef<number | null>(null);

  const onDown = (e: React.PointerEvent) => {
    dragY.current = e.clientY;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragY.current == null) return;
    const dy = e.clientY - dragY.current;
    dragY.current = e.clientY;
    if (dy !== 0) resizeBottom(-dy); // drag the divider UP (dy<0) → grow the bottom dock
  };
  const onUp = (e: React.PointerEvent) => {
    dragY.current = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  return (
    <div className="view arrange-view" data-testid="view" data-view="arrange">
      {children}
      {zone.collapsed ? (
        <button className="dock-collapsed" data-testid="dock-expand" onClick={toggleBottom}
          title="Show the detail panel">▴ Panel</button>
      ) : (
        <>
          <div className="dock-divider" data-testid="dock-divider" role="separator" aria-orientation="horizontal"
            aria-label="Resize the detail panel"
            title="Drag to resize · double-click to collapse"
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            onDoubleClick={toggleBottom} />
          <div className="dock-host" style={{ height: zone.size }}>{bottom}</div>
        </>
      )}
    </div>
  );
}
