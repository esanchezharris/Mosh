import { useEffect, useRef, useState } from "react";

// Live-render only what's on screen. Off-screen candidates hold no iframe / WebGL
// context (WebKit drops contexts past ~16), so the wall stays smooth at scale.
export function useOnScreen<T extends HTMLElement>(rootMargin = "300px"): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => setVisible(e.isIntersecting)),
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return [ref, visible];
}
