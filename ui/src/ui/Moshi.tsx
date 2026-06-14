// Moshi — the agent character, now genuinely REACTIVE per THE SYMBIOTE doctrine
// (HOUSE_STYLE §12/§33): one being, two channels.
//   BODY (the work)  ← spectral feed + song/AI params → energy/mood/heat + palette
//   FACE (the agent) ← transport/render/idle           → setState / celebrate
// The two never cross. moshi.js stays a pure component fed semantic scalars; nothing
// engine-specific leaks in (the seam stays swappable).
//
// Continuous body drives run on a smoothed rAF loop (read the store directly, no React
// churn); the face/state runs on a small React effect. A flux/onset gives a body beat
// pulse via an energy transient — NOT poke() (poke escalates to annoyance; it's for the
// user's clicks). Personality/palette shifts gently with the music's spectral character
// (long dwell, no thrash) — the "colours react" the user wanted.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import "../vendor/moshi.js";

type MoshiApi = {
  set: (k: string, v: number) => MoshiApi;
  setState: (s: string) => MoshiApi;
  setStyle: (s: string) => MoshiApi;
  setQuality: (q: string) => MoshiApi;
  setPersonality: (n: string | number, seed?: number, o?: { snap?: boolean }) => MoshiApi;
  celebrate: () => MoshiApi;
  poke: () => void;
  state: () => unknown;
  destroy: () => void;
};
declare global {
  interface Window { Moshi?: (host: HTMLElement, opts?: Record<string, unknown>) => MoshiApi }
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
// spectral character → personality family (bass-heavy → molten/tar, bright → disco/chrome)
const FAMILY_BY_CENTROID = ["MOLTEN", "TAR", "DISCO", "CHROME"];

export function Moshi() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MoshiApi | null>(null);

  const playing = useStore((s) => s.snapshot?.transport.playing ?? false);
  const recording = useStore((s) => s.snapshot?.transport.recording ?? false);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);

  // Mount once (PS2 register). WebGL failure degrades to an empty mount, not a crash.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.Moshi !== "function") return;
    let api: MoshiApi | null = null;
    try { api = window.Moshi(host, { personality: "TAR", seed: 0.5 }); api.setQuality("ps2"); apiRef.current = api; }
    catch { apiRef.current = null; }
    // Debug/automation hook: read Moshi's authoritative live state (incl. drives).
    (window as unknown as { __moshiState?: () => unknown }).__moshiState = () => apiRef.current?.state();
    return () => { try { api?.destroy(); } catch { /* noop */ } apiRef.current = null; };
  }, []);

  // ── BODY channel: smoothed continuous drives from spectrum + params ─────────
  // Timer-driven (not rAF): independent of compositor/visibility throttling, and
  // moshi.js does its own render interpolation, so 50 Hz target updates are smooth.
  useEffect(() => {
    const drive = { energy: 0.22, mood: 0.55, heat: 0.12 };
    let last = performance.now(), famIdx = 1, famSince = 0;
    const id = setInterval(() => {
      const api = apiRef.current;
      if (api) {
        const now = performance.now();
        const dt = Math.min(0.08, (now - last) / 1000); last = now;
        const s = useStore.getState();
        const spec = s.spectrum, snap = s.snapshot;
        const isPlaying = snap?.transport.playing ?? false;
        const isRec = snap?.transport.recording ?? false;
        const isRender = Object.keys(s.renderProgress).length > 0;
        const bands = spec.bands ?? [];
        const low = avg(bands.slice(0, 3));               // body weight
        const high = avg(bands.slice(Math.max(0, bands.length - 3))); // brightness
        const lvl = spec.level ?? 0;

        // params (the AI/work) — neural insert ASTD drive + render quality
        let neural = 0, qa = 0;
        for (const t of snap?.tracks ?? []) for (const p of t.plugins ?? [])
          if (p.neural) for (const np of p.neural.params) neural = Math.max(neural, np.ui / 100);
        for (const k of Object.keys(s.qaByClip)) { const v = s.qaByClip[k].pq; if (v != null) qa = Math.max(qa, v / 10); }

        // targets (BODY = work). flux gives a transient body pulse on the beat.
        const energyT = clamp((isPlaying ? 0.25 + 0.7 * (0.55 * low + 0.45 * lvl) : isRender ? 0.6 : 0.2) + (spec.flux ?? 0) * 0.3);
        const heatT = clamp(isRec ? 0.92 : 0.1 + 0.5 * high + 0.45 * neural + (isRender ? 0.35 : 0));
        const moodT = clamp(0.45 + 0.3 * qa + (isPlaying ? 0.15 : 0));

        const k = 1 - Math.exp(-dt * 7); // ~7/s smoothing — never jumps
        drive.energy += (energyT - drive.energy) * k;
        drive.heat += (heatT - drive.heat) * k;
        drive.mood += (moodT - drive.mood) * k;
        api.set("energy", drive.energy).set("heat", drive.heat).set("mood", drive.mood);

        // gentle palette shift with spectral centroid (>=5s dwell — no thrash).
        const tot = bands.reduce((a, b) => a + b, 0);
        if (tot > 0.05) {
          let cen = 0; for (let i = 0; i < bands.length; i++) cen += (i / Math.max(1, bands.length - 1)) * bands[i];
          cen /= tot;
          const want = Math.min(FAMILY_BY_CENTROID.length - 1, Math.floor(cen * FAMILY_BY_CENTROID.length));
          if (want !== famIdx && now - famSince > 5000) { famIdx = want; famSince = now; try { api.setPersonality(FAMILY_BY_CENTROID[want]); } catch { /* noop */ } }
        }

      }
    }, 1000 / 50);
    return () => clearInterval(id);
  }, []);

  // ── FACE channel: the agent's state (independent of the body) ───────────────
  useEffect(() => {
    const m = apiRef.current; if (!m) return;
    try { m.setState(recording ? "RECORDING" : rendering ? "RENDERING" : playing ? "LISTENING" : "IDLE"); } catch { /* noop */ }
  }, [playing, recording, rendering]);

  return (
    <div ref={hostRef} className="moshi-mount" data-testid="moshi" title="Moshi — poke him"
      onClick={() => { try { apiRef.current?.poke?.(); } catch { /* noop */ } }} />
  );
}
