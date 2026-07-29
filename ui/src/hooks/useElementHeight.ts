import { useEffect, useRef, useState } from "react";

// Track an element's rendered height (clientHeight) so windowed lists can keep
// their visible-range math accurate across resizes. Reads once on mount, then
// follows live via ResizeObserver — skipped where the API is unavailable (e.g.
// a bare jsdom), in which case the initial read still lands. Extracted from the
// identical inline effect in the classic plugin modal (ui/PluginBrowser.tsx)
// and the v2 picker list (v2/PluginBrowser.tsx).
//
// `initial` is the height used until the first measurement (and forever in
// non-DOM environments where the ref never attaches).
export function useElementHeight<T extends HTMLElement>(initial = 0) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(initial);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => setHeight(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, height };
}
