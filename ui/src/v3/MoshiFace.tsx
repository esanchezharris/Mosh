import { useEffect, useRef } from "react";
import "../vendor/moshi.js";

type MoshiApi = {
  celebrate: () => MoshiApi;
  setQuality: (q: string) => MoshiApi;
  setAnatomy: (n: string) => MoshiApi;
  destroy: () => void;
};

type MoshiFactory = (host: HTMLElement, opts?: Record<string, unknown>) => MoshiApi;

/** Live face: TAR + seed 0, idle + celebrate() only. Never setState("RECORDING"). */
export function MoshiFace({ celebrateTick }: { celebrateTick: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MoshiApi | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const factory = (window as Window & { Moshi?: MoshiFactory }).Moshi;
    if (!host || typeof factory !== "function") return;
    let api: MoshiApi | null = null;
    try {
      api = factory(host, { personality: "TAR", seed: 0, resDiv: 1 });
      api.setQuality("ps2");
      api.setAnatomy("A");
      apiRef.current = api;
    } catch {
      apiRef.current = null;
    }
    return () => {
      api?.destroy();
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (celebrateTick > 0) apiRef.current?.celebrate();
  }, [celebrateTick]);

  return (
    <div className="moshi-host" ref={hostRef} data-testid="v3-moshi-face" aria-hidden="true">
      <svg viewBox="0 0 28 28" width="28" height="28">
        <circle cx="14" cy="14" r="10" fill="#2A2E2E" />
        <circle cx="10" cy="12" r="1.4" fill="#E8E2D6" />
        <circle cx="18" cy="12" r="1.4" fill="#E8E2D6" />
      </svg>
    </div>
  );
}
