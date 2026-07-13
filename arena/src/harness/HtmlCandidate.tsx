import { useEffect, useMemo, useRef } from "react";
import { wrapHtml, IFRAME_SANDBOX } from "./sandbox";
import { transport } from "./transport";
import type { Theme } from "../kit/tokens";

// Renders an HTML candidate inside a locked-down sandbox iframe and feeds it the shared
// transport clock (throttled ~30Hz) so animated looks stay in lockstep with the wall.
// When usesMoshi, the real Moshi creature runtime is injected so the candidate can mount it.
export function HtmlCandidate({
  source,
  theme = "dark",
  live,
  usesMoshi = false,
}: {
  source: string;
  theme?: Theme;
  live: boolean;
  usesMoshi?: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => wrapHtml(source, theme, { moshi: usesMoshi }), [source, theme, usesMoshi]);

  useEffect(() => {
    if (!live) return;
    let lastPost = 0;
    const unsub = transport.subscribe((s) => {
      const now = performance.now();
      if (now - lastPost < 33) return;
      lastPost = now;
      ref.current?.contentWindow?.postMessage(
        { type: "mosh-transport", time: s.time, playhead: s.playhead, playing: s.playing },
        "*",
      );
    });
    return unsub;
  }, [live]);

  if (!live) return <div className="cand-poster" aria-hidden />;
  return (
    <iframe
      ref={ref}
      title="candidate"
      sandbox={IFRAME_SANDBOX}
      srcDoc={doc}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}
