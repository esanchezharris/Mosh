import { useEffect, useRef, useState } from "react";
import "../vendor/moshi.js";

type MoshiApi = {
  celebrate: () => MoshiApi;
  setQuality: (q: string) => MoshiApi;
  setAnatomy: (n: string) => MoshiApi;
  destroy: () => void;
};

type MoshiFactory = (host: HTMLElement, opts?: Record<string, unknown>) => MoshiApi;

/** Live face: the same creature v2's dock mounts (TAR, seed 0.5, anatomy A, ps2), idle +
 *  celebrate() only. Never setState("RECORDING"). The two-dot SVG is a PLACEHOLDER for
 *  when moshi.js is unavailable: it unmounts the moment the canvas is live — before this
 *  it stayed in front of the canvas inside the clipped host, so the shipped app showed
 *  the placeholder over the real avatar (owner report, 2026-09-20). */
export function MoshiFace({ celebrateTick }: { celebrateTick: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MoshiApi | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const factory = (window as Window & { Moshi?: MoshiFactory }).Moshi;
    if (!host || typeof factory !== "function") return;
    let api: MoshiApi | null = null;
    try {
      api = factory(host, { personality: "TAR", seed: 0.5, resDiv: 1 });
      api.setQuality("ps2");
      api.setAnatomy("A");
      apiRef.current = api;
      setLive(true);
    } catch {
      apiRef.current = null;
      setLive(false);
    }
    return () => {
      api?.destroy();
      apiRef.current = null;
      setLive(false);
    };
  }, []);

  useEffect(() => {
    if (celebrateTick > 0) apiRef.current?.celebrate();
  }, [celebrateTick]);

  return (
    <div className="moshi-host" ref={hostRef} data-testid="v3-moshi-face" data-live={live || undefined} aria-hidden="true">
      {!live && (
        <svg viewBox="0 0 28 28" width="100%" height="100%">
          <circle cx="14" cy="14" r="10" fill="#2A2E2E" />
          <circle cx="10" cy="12" r="1.4" fill="#E8E2D6" />
          <circle cx="18" cy="12" r="1.4" fill="#E8E2D6" />
        </svg>
      )}
    </div>
  );
}
