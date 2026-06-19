// Dock shell (Phase 6) — the fixed-zone layout for the arrange view:
//   • LEFT browser zone — resizable (vertical divider) + collapsible to a rail.
//   • CENTER — the main area (Arrange), fills.
//   • BOTTOM detail dock — resizable (horizontal divider) + collapsible.
// Zone sizes + collapsed state are UI-local and persisted (useDockLayout); all
// geometry is the pure dockLayout engine. The floating drum window (FloatingWindow)
// layers over the top of this for the FL layout.

import { useRef, type ReactNode } from "react";
import { useDockLayout } from "./useDockLayout";

export function DockShell({ left, children, bottom }: { left: ReactNode; children: ReactNode; bottom: ReactNode }) {
  const bottomZone = useDockLayout((s) => s.bottom);
  const leftZone = useDockLayout((s) => s.left);
  const resizeBottom = useDockLayout((s) => s.resizeBottom);
  const toggleBottom = useDockLayout((s) => s.toggleBottom);
  const resizeLeft = useDockLayout((s) => s.resizeLeft);
  const toggleLeft = useDockLayout((s) => s.toggleLeft);

  // One drag tracker reused by both dividers (only one drags at a time).
  const last = useRef<{ axis: "x" | "y"; v: number } | null>(null);
  const begin = (axis: "x" | "y") => (e: React.PointerEvent) => {
    last.current = { axis, v: axis === "x" ? e.clientX : e.clientY };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const drag = (e: React.PointerEvent) => {
    if (!last.current) return;
    if (last.current.axis === "x") {
      const dx = e.clientX - last.current.v; last.current.v = e.clientX;
      if (dx !== 0) resizeLeft(dx);           // drag the divider RIGHT → grow the browser
    } else {
      const dy = e.clientY - last.current.v; last.current.v = e.clientY;
      if (dy !== 0) resizeBottom(-dy);         // drag the divider UP → grow the bottom dock
    }
  };
  const end = (e: React.PointerEvent) => {
    last.current = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  return (
    <div className="view arrange-view" data-testid="view" data-view="arrange">
      <div className="dock-main">
        {leftZone.collapsed ? (
          <button className="dock-left-rail" data-testid="browser-expand" onClick={toggleLeft}
            title="Show the browser">▸</button>
        ) : (
          <>
            <div className="dock-left" data-testid="dock-left" style={{ width: leftZone.size }}>{left}</div>
            <div className="dock-vdivider" data-testid="dock-vdivider" role="separator" aria-orientation="vertical"
              aria-label="Resize the browser" title="Drag to resize · double-click to collapse"
              onPointerDown={begin("x")} onPointerMove={drag} onPointerUp={end} onDoubleClick={toggleLeft} />
          </>
        )}
        {children}
      </div>
      {bottomZone.collapsed ? (
        <button className="dock-collapsed" data-testid="dock-expand" onClick={toggleBottom}
          title="Show the detail panel">▴ Panel</button>
      ) : (
        <>
          <div className="dock-divider" data-testid="dock-divider" role="separator" aria-orientation="horizontal"
            aria-label="Resize the detail panel" title="Drag to resize · double-click to collapse"
            onPointerDown={begin("y")} onPointerMove={drag} onPointerUp={end} onDoubleClick={toggleBottom} />
          <div className="dock-host" style={{ height: bottomZone.size }}>{bottom}</div>
        </>
      )}
    </div>
  );
}
