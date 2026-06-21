// Dock shell (Phase 6) — the fixed-zone layout for the arrange view:
//   • LEFT browser zone — resizable (vertical divider) + collapsible to a rail.
//   • CENTER — the main area (Arrange), fills.
//   • BOTTOM detail dock — resizable (horizontal divider) + collapsible.
// Zone sizes + collapsed state are UI-local and persisted (useDockLayout); all
// geometry is the pure dockLayout engine. The floating drum window (FloatingWindow)
// layers over the top of this for the FL layout.

import { useRef, type ReactNode } from "react";
import { useDockLayout } from "./useDockLayout";

export function DockShell({ left, children, right, bottom }: { left: ReactNode; children: ReactNode; right?: ReactNode; bottom: ReactNode }) {
  const bottomZone = useDockLayout((s) => s.bottom);
  const leftZone = useDockLayout((s) => s.left);
  const rightZone = useDockLayout((s) => s.right);
  const resizeBottom = useDockLayout((s) => s.resizeBottom);
  const toggleBottom = useDockLayout((s) => s.toggleBottom);
  const resizeLeft = useDockLayout((s) => s.resizeLeft);
  const toggleLeft = useDockLayout((s) => s.toggleLeft);
  const resizeRight = useDockLayout((s) => s.resizeRight);
  const toggleRight = useDockLayout((s) => s.toggleRight);

  // One drag tracker reused by the three dividers (only one drags at a time).
  const last = useRef<{ kind: "left" | "right" | "bottom"; v: number } | null>(null);
  const begin = (kind: "left" | "right" | "bottom") => (e: React.PointerEvent) => {
    last.current = { kind, v: kind === "bottom" ? e.clientY : e.clientX };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const drag = (e: React.PointerEvent) => {
    if (!last.current) return;
    if (last.current.kind === "bottom") {
      const dy = e.clientY - last.current.v; last.current.v = e.clientY;
      if (dy !== 0) resizeBottom(-dy);             // drag UP → grow the bottom dock
    } else {
      const dx = e.clientX - last.current.v; last.current.v = e.clientX;
      if (dx === 0) return;
      if (last.current.kind === "left") resizeLeft(dx);   // drag RIGHT → grow the browser
      else resizeRight(-dx);                              // drag LEFT → grow the Inspector
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
              onPointerDown={begin("left")} onPointerMove={drag} onPointerUp={end} onDoubleClick={toggleLeft} />
          </>
        )}
        {children}
        {right && (
          <>
            {rightZone.collapsed ? (
              <button className="dock-right-rail" data-testid="inspector-expand" onClick={toggleRight}
                title="Show the session panel">◂</button>
            ) : (
              <div className="dock-vdivider" data-testid="dock-rdivider" role="separator" aria-orientation="vertical"
                aria-label="Resize the session panel" title="Drag to resize · double-click to collapse"
                onPointerDown={begin("right")} onPointerMove={drag} onPointerUp={end} onDoubleClick={toggleRight} />
            )}
            {/* Keep the panel MOUNTED when collapsed (hidden, not removed) so a live
                participant — Moshi's GL + Web Audio voice — isn't torn down on collapse. */}
            <div className="dock-right" data-testid="dock-right" hidden={rightZone.collapsed}
              style={{ width: rightZone.collapsed ? 0 : rightZone.size }}>{right}</div>
          </>
        )}
      </div>
      {bottomZone.collapsed ? (
        <button className="dock-collapsed" data-testid="dock-expand" onClick={toggleBottom}
          title="Show the detail panel">▴ Panel</button>
      ) : (
        <>
          <div className="dock-divider" data-testid="dock-divider" role="separator" aria-orientation="horizontal"
            aria-label="Resize the detail panel" title="Drag to resize · double-click to collapse"
            onPointerDown={begin("bottom")} onPointerMove={drag} onPointerUp={end} onDoubleClick={toggleBottom} />
          <div className="dock-host" style={{ height: bottomZone.size }}>{bottom}</div>
        </>
      )}
    </div>
  );
}
