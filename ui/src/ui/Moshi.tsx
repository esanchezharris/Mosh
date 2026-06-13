// Moshi — the agent character (the design-lab keeper), mounted as a presence.
// moshi.js is a self-contained WebGL1 component with SEMANTIC drives (energy /
// mood / heat) + agent states; the host feeds it scalars derived from app state
// and NOTHING engine-specific crosses into it (HOUSE_STYLE §21 — the seam stays
// swappable). The vendored copy mirrors design-lab/playground/moshi.js.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import "../vendor/moshi.js";

type MoshiApi = {
  set: (k: string, v: number) => MoshiApi;
  setState: (s: string) => MoshiApi;
  setStyle: (s: string) => MoshiApi;
  setQuality: (q: string) => MoshiApi;
  celebrate: () => MoshiApi;
  poke: () => void;
  destroy: () => void;
};
declare global {
  interface Window { Moshi?: (host: HTMLElement, opts?: Record<string, unknown>) => MoshiApi }
}

export function Moshi() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MoshiApi | null>(null);

  const playing = useStore((s) => s.snapshot?.transport.playing ?? false);
  const recording = useStore((s) => s.snapshot?.transport.recording ?? false);
  // "rendering" = any Tier-B render layer in flight (drives the RENDERING state + heat).
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);

  // Mount once; PS2 register is the default. Guard WebGL failure so a context
  // problem degrades to an empty orb instead of unmounting the whole app.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.Moshi !== "function") return;
    let api: MoshiApi | null = null;
    try {
      api = window.Moshi(host, { personality: "TAR", seed: 0.5 });
      api.setQuality("ps2");
      apiRef.current = api;
    } catch {
      apiRef.current = null;
    }
    return () => { try { api?.destroy(); } catch { /* noop */ } apiRef.current = null; };
  }, []);

  // Drive the semantic scalars from transport / render state.
  useEffect(() => {
    const m = apiRef.current; if (!m) return;
    const state = recording ? "RECORDING" : rendering ? "RENDERING" : playing ? "LISTENING" : "IDLE";
    try {
      m.setState(state);
      m.set("energy", playing || rendering ? 0.72 : 0.22);
      m.set("heat", recording ? 0.9 : rendering ? 0.55 : 0.12);
      m.set("mood", 0.6);
    } catch { /* noop */ }
  }, [playing, recording, rendering]);

  return (
    <div
      ref={hostRef}
      className="moshi-mount"
      data-testid="moshi"
      title="Moshi — poke him"
      onClick={() => { try { apiRef.current?.poke?.(); } catch { /* noop */ } }}
    />
  );
}
