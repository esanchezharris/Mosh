import { useEffect, useRef, useState, type ReactNode } from "react";

// Renders its child at a FIXED design size (e.g. 1440×900) and scales it to FIT the
// container (min of the width/height ratios), centered. This is the fix for "previews
// scaled in terrible ways": a whole-shell mockup authored at real DAW resolution shows
// as a crisp, true-to-life miniature instead of a cramped reflow. The container sizes
// itself (a 16:10 grid tile, or the lightbox stage); ScaledFrame just fits into it.
export function ScaledFrame({
  designW,
  designH,
  children,
}: {
  designW: number;
  designH: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ scale: 0, x: 0, y: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const scale = Math.min(w / designW, h / designH);
      setT({ scale, x: (w - designW * scale) / 2, y: (h - designH * scale) / 2 });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [designW, designH]);

  return (
    <div ref={ref} className="scaled-frame">
      <div
        className="scaled-inner"
        style={{
          width: designW,
          height: designH,
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transformOrigin: "top left",
        }}
      >
        {t.scale > 0 && children}
      </div>
    </div>
  );
}
