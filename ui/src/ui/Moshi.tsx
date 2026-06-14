// Moshi — the agent character, genuinely REACTIVE per THE SYMBIOTE doctrine
// (HOUSE_STYLE §12/§33): one being, two channels.
//   BODY (the work)  ← spectral feed + song/AI params → energy/mood/heat + palette
//   FACE (the agent) ← transport/render/idle/voice     → setState / celebrate / utter
// The two never cross, and nothing engine-specific leaks in (the seam stays swappable).
//
// Continuous body drives run on a smoothed 50 Hz loop (read the store directly, no React
// churn). The FACE adds a non-verbal VOICE (R2-D2-style earcons, voice.js): he co-fires a
// sound + body beat on key moments — render working, take accepted, errors, a hello on the
// first gesture, and a soft idle murmur. Audio stays locked (muted by default) until the
// user opts in AND a gesture unlocks the AudioContext. "In the song's key" is a documented
// future seam — the engine has no key feed yet, so he sings in a neutral A-minor.

import { useCallback, useEffect, useRef } from "react";
import { useStore } from "../store";
import "../vendor/moshi.js";
import "../vendor/voice.js";

type MoshiApi = {
  set: (k: string, v: number) => MoshiApi;
  setState: (s: string) => MoshiApi;
  setStyle: (s: string) => MoshiApi;
  setQuality: (q: string) => MoshiApi;
  setAnatomy: (n: string) => MoshiApi;
  setPersonality: (n: string | number, seed?: number, o?: { snap?: boolean }) => MoshiApi;
  setPose: (n: string, hold?: number) => MoshiApi;
  lookAt: (nx: number, ny: number) => MoshiApi;
  celebrate: () => MoshiApi;
  poke: () => void;
  state: () => unknown;
  destroy: () => void;
};
type VoiceApi = {
  unlock: () => void;
  isReady: () => boolean;
  play: (intent: string, o?: Record<string, unknown>) => unknown;
  setKey: (name: string, mode?: string, octave?: number) => VoiceApi;
  startLoop: (intent: string, o?: Record<string, unknown>) => VoiceApi;
  stopLoop: () => VoiceApi;
  setEnabled: (b: boolean) => VoiceApi;
  setMaster: (v: number) => VoiceApi;
  destroy: () => VoiceApi;
};
declare global {
  interface Window {
    Moshi?: (host: HTMLElement, opts?: Record<string, unknown>) => MoshiApi;
    MoshiVoice?: (opts?: Record<string, unknown>) => VoiceApi;
  }
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
// spectral character → personality family (bass-heavy → molten/tar, bright → disco/chrome)
const FAMILY_BY_CENTROID = ["MOLTEN", "TAR", "DISCO", "CHROME"];

export function Moshi() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MoshiApi | null>(null);
  const voiceRef = useRef<VoiceApi | null>(null);

  const playing = useStore((s) => s.snapshot?.transport.playing ?? false);
  const recording = useStore((s) => s.snapshot?.transport.recording ?? false);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const lastCelebrateAt = useStore((s) => s.lastCelebrateAt);
  const lastError = useStore((s) => s.lastError);
  const muted = useStore((s) => s.moshiMuted);

  // utter — co-fire an earcon with a body reaction. Stable (refs only). Defensive:
  // an unknown intent / locked-or-muted voice just no-ops, never throws.
  const utter = useCallback((intent: string, opts?: { loop?: boolean }) => {
    const v = voiceRef.current, m = apiRef.current;
    try { if (opts?.loop) v?.startLoop(intent); else v?.play(intent); } catch { /* noop */ }
    try {
      if (intent === "DONE") m?.celebrate();
      else if (intent === "GREET") m?.lookAt(0, -0.1);
      else if (intent === "UHOH") m?.setPose("DROOP", 1.0);
    } catch { /* noop */ }
  }, []);

  // Mount the character + the voice once. WebGL/voice failure degrades to silence, not a crash.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.Moshi !== "function") return;
    let api: MoshiApi | null = null;
    try {
      api = window.Moshi(host, { personality: "TAR", seed: 0.5 });
      api.setQuality("ps2");
      api.setAnatomy("A"); // baked default — the silhouette every gate screenshot shipped
      apiRef.current = api;
    } catch { apiRef.current = null; }
    try {
      if (typeof window.MoshiVoice === "function") {
        const v = window.MoshiVoice({ master: 0.5, enabled: false }); // stays silent until unmuted
        v.setKey("A", "minor"); // neutral default; a real key feed is a future seam
        voiceRef.current = v;
      }
    } catch { voiceRef.current = null; }
    // Debug/automation hooks.
    (window as unknown as { __moshiState?: () => unknown }).__moshiState = () => apiRef.current?.state();
    (window as unknown as { __moshiUtter?: (i: string) => void }).__moshiUtter = (i) => utter(i);
    return () => {
      try { api?.destroy(); } catch { /* noop */ }
      try { voiceRef.current?.destroy(); } catch { /* noop */ }
      apiRef.current = null; voiceRef.current = null;
    };
  }, [utter]);

  // Unlock the AudioContext on the first user gesture (browsers require it), and greet
  // right after so the hello actually sounds (if unmuted).
  useEffect(() => {
    const unlock = () => {
      try { voiceRef.current?.unlock(); } catch { /* noop */ }
      setTimeout(() => utter("GREET"), 140);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [utter]);

  // Keep the voice's enabled flag in sync with the UI-local mute.
  useEffect(() => { try { voiceRef.current?.setEnabled(!muted); } catch { /* noop */ } }, [muted]);

  // ── BODY channel: smoothed continuous drives + idle ambient life ────────────
  useEffect(() => {
    const drive = { energy: 0.22, mood: 0.55, heat: 0.12 };
    let last = performance.now(), famIdx = 1, famSince = 0, nextMurmur = last + 6000;
    const id = setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const now = performance.now();
      const dt = Math.min(0.08, (now - last) / 1000); last = now;
      const s = useStore.getState();
      const spec = s.spectrum, snap = s.snapshot;
      const isPlaying = snap?.transport.playing ?? false;
      const isRec = snap?.transport.recording ?? false;
      const isRender = Object.keys(s.renderProgress).length > 0;
      const idle = !isPlaying && !isRec && !isRender;
      const bands = spec.bands ?? [];
      const low = avg(bands.slice(0, 3));
      const high = avg(bands.slice(Math.max(0, bands.length - 3)));
      const lvl = spec.level ?? 0;

      // params (the AI/work) — neural insert ASTD drive + render quality
      let neural = 0, qa = 0;
      for (const t of snap?.tracks ?? []) for (const p of t.plugins ?? [])
        if (p.neural) for (const np of p.neural.params) neural = Math.max(neural, np.ui / 100);
      for (const k of Object.keys(s.qaByClip)) { const v = s.qaByClip[k].pq; if (v != null) qa = Math.max(qa, v / 10); }

      // BODY targets. flux = beat transient. Idle gets a slow breath so he's never fully still.
      const breath = idle ? 0.18 + 0.06 * Math.sin(now / 2100) : 0;
      const energyT = clamp((isPlaying ? 0.25 + 0.7 * (0.55 * low + 0.45 * lvl) : isRender ? 0.6 : breath) + (spec.flux ?? 0) * 0.3);
      const heatT = clamp(isRec ? 0.92 : 0.1 + 0.5 * high + 0.45 * neural + (isRender ? 0.35 : 0));
      const moodT = clamp(0.45 + 0.3 * qa + (isPlaying ? 0.15 : 0));

      const k = 1 - Math.exp(-dt * 7); // ~7/s smoothing — never jumps
      drive.energy += (energyT - drive.energy) * k;
      drive.heat += (heatT - drive.heat) * k;
      drive.mood += (moodT - drive.mood) * k;
      api.set("energy", drive.energy).set("heat", drive.heat).set("mood", drive.mood);

      // gentle palette shift with spectral centroid (>=5s dwell — no thrash)
      const tot = bands.reduce((a, b) => a + b, 0);
      if (tot > 0.05) {
        let cen = 0; for (let i = 0; i < bands.length; i++) cen += (i / Math.max(1, bands.length - 1)) * bands[i];
        cen /= tot;
        const want = Math.min(FAMILY_BY_CENTROID.length - 1, Math.floor(cen * FAMILY_BY_CENTROID.length));
        if (want !== famIdx && now - famSince > 5000) { famIdx = want; famSince = now; try { api.setPersonality(FAMILY_BY_CENTROID[want]); } catch { /* noop */ } }
      }

      // idle murmur — a soft to-himself coo every ~10–18s, only when visible (moshi.js
      // already runs its own gaze/idle behaviour, so we don't drive saccades here).
      if (idle && now > nextMurmur) {
        nextMurmur = now + 10000 + Math.random() * 8000;
        if (document.visibilityState === "visible") utter("IDLE_MURMUR");
      }
    }, 1000 / 50);
    return () => clearInterval(id);
  }, [utter]);

  // ── FACE channel: the agent's state ─────────────────────────────────────────
  useEffect(() => {
    const m = apiRef.current; if (!m) return;
    try { m.setState(recording ? "RECORDING" : rendering ? "RENDERING" : playing ? "LISTENING" : "IDLE"); } catch { /* noop */ }
  }, [playing, recording, rendering]);

  // Voice triggers off existing store fields (defensive — silent unless unmuted).
  useEffect(() => { if (rendering) utter("ACK_WORKING", { loop: true }); else voiceRef.current?.stopLoop(); }, [rendering, utter]);
  useEffect(() => { if (lastCelebrateAt) utter("DONE"); }, [lastCelebrateAt, utter]);
  useEffect(() => { if (lastError) utter("UHOH"); }, [lastError, utter]);

  return (
    <div ref={hostRef} className="moshi-mount" data-testid="moshi" title="Moshi — poke him"
      onClick={() => { try { apiRef.current?.poke?.(); } catch { /* noop */ } }} />
  );
}
