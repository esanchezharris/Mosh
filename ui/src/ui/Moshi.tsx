// Moshi — the agent character (the design-lab keeper), mounted as a presence and
// now ALIVE in the product: he swells with the live mix, perks up when playback
// starts, burbles while a render runs, and celebrates a landed take — all through
// his own semantic drives + a non-verbal voice. NOTHING engine-specific crosses
// into moshi.js (HOUSE_STYLE §21 — the seam stays swappable); the host only feeds
// scalars derived from store events (levels / transport / render).

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { AgentComposer } from "./AgentComposer";
import "../vendor/moshi.js";
import "../vendor/voice.js";

type MoshiApi = {
  set: (k: string, v: number) => MoshiApi;
  setState: (s: string) => MoshiApi;
  setPose: (n: string, hold?: number) => MoshiApi;
  setStyle: (s: string) => MoshiApi;
  setQuality: (q: string) => MoshiApi;
  setPersonality: (n: string | number, seed?: number, o?: object) => MoshiApi;
  celebrate: () => MoshiApi;
  lookAt: (nx: number, ny: number) => MoshiApi;
  poke: () => void;
  state: () => { state: string };
  destroy: () => void;
};
type VoiceApi = {
  unlock: () => void;
  isReady: () => boolean;
  play: (intent: string, o?: object) => unknown;
  startLoop: (intent: string, o?: object) => VoiceApi;
  stopLoop: () => VoiceApi;
  setEnabled: (b: boolean) => VoiceApi;
  setMaster: (v: number) => VoiceApi;
  setKey: (name: string | number, mode?: string, octave?: number) => VoiceApi;
  destroy: () => VoiceApi;
};
declare global {
  interface Window {
    Moshi?: (host: HTMLElement, opts?: Record<string, unknown>) => MoshiApi;
    MoshiVoice?: (opts?: Record<string, unknown>) => VoiceApi;
  }
}

type Affect = { valence?: number; arousal?: number };
// intent → his BODY reaction (the sound is added by the voice; this is the pose/face).
// Ported verbatim from design-lab/playground/index.html so behaviour matches the lab.
const INTENT_REACTION: Record<string, { pose?: string; hold?: number; mood?: number; state?: string; celebrate?: boolean }> = {
  ACK_WORKING: { state: "RENDERING" },
  DONE: { celebrate: true },
  UHOH: { pose: "TUCK", hold: 1.6, mood: 0.25 },
  GREET: { pose: "WAVE", hold: 2.0, mood: 0.85 },
  IDLE_MURMUR: {},
};

// He greets once when the app opens. Module-scoped so he does NOT re-greet each
// time the dock remounts him on an arrange/mixer view switch.
let hasGreetedThisSession = false;

export function Moshi() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<MoshiApi | null>(null);
  const voiceRef = useRef<VoiceApi | null>(null);
  const workingLoop = useRef(false);
  // the utter() funnel lives in a ref so the discrete-event effects can call it.
  const utterRef = useRef<(intent: string, o?: { affect?: Affect; seed?: number }) => void>(() => {});

  const playing = useStore((s) => s.snapshot?.transport.playing ?? false);
  const recording = useStore((s) => s.snapshot?.transport.recording ?? false);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const celebrateTick = useStore((s) => s.celebrateTick);
  const voiceOn = useStore((s) => s.voiceOn);
  const qaByClip = useStore((s) => s.qaByClip);

  // ── mount once: moshi + voice + the funnel + energy loop + first-open greet ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.Moshi !== "function") return;
    let api: MoshiApi | null = null;
    try {
      // resDiv:1 + the devicePixelRatio fix in moshi.js resize() => the GL buffer
      // renders at the orb's TRUE physical pixel size (1:1 crisp at 52px on Retina).
      // quality stays 'ps2' so the wobble/dither character is unchanged — only the
      // chunky low-res pixelation is removed.
      api = window.Moshi(host, { personality: "TAR", seed: 0.5, resDiv: 1 });
      api.setQuality("ps2");
      apiRef.current = api;
    } catch { apiRef.current = null; }

    // voice (Web Audio) — guarded so a missing AudioContext can never break the UI
    try {
      if (typeof window.MoshiVoice === "function") {
        const v = window.MoshiVoice({ master: 0.55, enabled: useStore.getState().voiceOn });
        v.setKey("A", "minor"); // STUB: the engine tracks no musical key yet (see voice.js)
        voiceRef.current = v;
      }
    } catch { voiceRef.current = null; }

    // THE FUNNEL — one place co-fires sound + body pose/state (mirrors the lab).
    utterRef.current = (intent, o = {}) => {
      const v = voiceRef.current, m = apiRef.current;
      if (v) {
        try {
          v.unlock();
          if (intent === "ACK_WORKING") { v.startLoop(intent, { affect: o.affect }); workingLoop.current = true; }
          else {
            if (workingLoop.current) { v.stopLoop(); workingLoop.current = false; }
            v.play(intent, { affect: o.affect, seed: o.seed });
          }
        } catch { /* noop */ }
      }
      const r = INTENT_REACTION[intent] || {};
      if (m) {
        try {
          if (r.celebrate) m.celebrate();
          else if (r.pose) m.setPose(r.pose, r.hold);
          if (r.state) m.setState(r.state);
          if (typeof r.mood === "number") m.set("mood", r.mood);
        } catch { /* noop */ }
      }
    };

    // autoplay: an AudioContext may only start inside a user gesture — prime once.
    const prime = () => { try { voiceRef.current?.unlock(); } catch { /* noop */ } };
    window.addEventListener("pointerdown", prime, { capture: true, once: true });
    window.addEventListener("keydown", prime, { capture: true, once: true });

    // energy from the live mix — a rAF loop reads levels TRANSIENTLY (getState, no
    // re-render) and feeds a single smoothed scalar, so his body swells with the
    // actual loudness of the mix. O(1) per frame, no allocation.
    let raf = 0, eMA = 0, lastDuck = -1;
    const tick = () => {
      const m = apiRef.current;
      if (m) {
        const st = useStore.getState();
        const lv = st.levels.master;
        const db = Math.max(lv.l, lv.r);
        const target = Math.max(0, Math.min(1, (db + 60) / 60));
        eMA += (target - eMA) * 0.15;
        try {
          m.set("energy", eMA);
          // duck the voice under a loud mix so his coos sit below the music
          const v = voiceRef.current;
          if (v) {
            const duck = st.snapshot?.transport.playing && eMA > 0.4 ? 0.45 : 1;
            const want = st.voiceVol * duck;
            if (Math.abs(want - lastDuck) > 0.05) { v.setMaster(want); lastDuck = want; }
          }
        } catch { /* noop */ }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // (idle murmur removed — he no longer mutters to himself unprompted; he only
    // speaks in response to events. The IDLE_MURMUR intent is still wired in the
    // voice/reaction maps if we ever want to bring back a much rarer idle beat.)

    // a little hello when the app first opens (gated to once per session)
    const greetT = window.setTimeout(() => {
      if (hasGreetedThisSession) return;
      hasGreetedThisSession = true;
      utterRef.current("GREET", { affect: { valence: 0.8, arousal: 0.7 } });
    }, 700);

    // pause battery/CPU when the window is hidden
    const onVis = () => {
      if (document.hidden) { cancelAnimationFrame(raf); }
      else { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(greetT);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointerdown", prime, true);
      window.removeEventListener("keydown", prime, true);
      try { voiceRef.current?.destroy(); } catch { /* noop */ }
      try { api?.destroy(); } catch { /* noop */ }
      apiRef.current = null; voiceRef.current = null;
    };
  }, []);

  // ── discrete agent state + anticipation ─────────────────────────────────────
  const prevPlaying = useRef(false);
  const pauseTimer = useRef(0);
  useEffect(() => {
    const m = apiRef.current; if (!m) return;
    clearTimeout(pauseTimer.current); // a fresh state change cancels any pending PAUSED→IDLE
    try {
      if (recording) m.setState("RECORDING");
      else if (rendering) m.setState("RENDERING");
      else if (playing) {
        m.setState("LISTENING");
        if (!prevPlaying.current) m.lookAt(0, 0.1); // perk up the instant audio starts
      } else if (prevPlaying.current) {
        // just stopped after playing → held-breath PAUSED, then settle to IDLE
        m.setState("PAUSED");
        pauseTimer.current = window.setTimeout(() => { try { apiRef.current?.setState("IDLE"); } catch { /* noop */ } }, 2600);
      } else {
        m.setState("IDLE");
      }
    } catch { /* noop */ }
    prevPlaying.current = playing;
  }, [playing, recording, rendering]);

  // ── render lifecycle voice: burble while working, exhale when it resolves ────
  const wasRendering = useRef(false);
  useEffect(() => {
    if (rendering && !wasRendering.current) utterRef.current("ACK_WORKING", { affect: { valence: 0.1, arousal: 0.4 } });
    else if (!rendering && wasRendering.current) {
      // stop the loop cleanly; a celebrate/DONE (accept) lands via celebrateTick below
      try { voiceRef.current?.stopLoop(); } catch { /* noop */ }
      workingLoop.current = false;
    }
    wasRendering.current = rendering;
  }, [rendering]);

  // ── the reward: a take landed (accept_render bumps celebrateTick) ────────────
  useEffect(() => {
    if (celebrateTick > 0) utterRef.current("DONE", { affect: { valence: 0.9, arousal: 0.9 } });
  }, [celebrateTick]);

  // ── commiserate on a degraded/failed render (fires once per new flag set) ────
  const seenDegraded = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const [clipId, qa] of Object.entries(qaByClip)) {
      const flags = qa?.flags ?? [];
      if (!flags.includes("quality_degraded")) continue;
      const key = clipId + ":" + flags.join(",");
      if (seenDegraded.current.has(key)) continue;
      seenDegraded.current.add(key);
      utterRef.current("UHOH", { affect: { valence: -0.6, arousal: 0.5 } });
    }
  }, [qaByClip]);

  // ── voice enable follows the UI toggle ──────────────────────────────────────
  useEffect(() => { try { voiceRef.current?.setEnabled(voiceOn); } catch { /* noop */ } }, [voiceOn]);

  // ── react to the agent's reply (voice + pose) — the composer pushes an utter ─
  const agentUtter = useStore((s) => s.agentUtter);
  useEffect(() => {
    if (agentUtter) utterRef.current(agentUtter.intent, { affect: { valence: 0.6, arousal: 0.6 } });
  }, [agentUtter]);

  // ── perk toward the user the moment hold-to-talk starts (he's listening to YOU)─
  const agentListening = useStore((s) => s.agentListening);
  useEffect(() => {
    const m = apiRef.current; if (!m || !agentListening) return;
    try { m.lookAt(0, 0.18); } catch { /* noop */ } // transient nudge; eases back on its own
  }, [agentListening]);

  const toggleVoice = useStore((s) => s.toggleVoice);
  const stateLabel = recording ? "● rec" : rendering ? "working…" : playing ? "listening" : "idle";

  // Fixed dock panel (lives at the right of the bottom dock, by the generative
  // drawer — where his reactions happen). Not floating, not draggable.
  return (
    <div className="moshi-dock" data-testid="moshi-stage">
      <div className="moshi-cap">
        <span className="moshi-state tc">{stateLabel}</span>
        <button className="moshi-mute" data-testid="moshi-mute" aria-pressed={!voiceOn}
          title={voiceOn ? "Mute Moshi" : "Unmute Moshi"} aria-label={voiceOn ? "Mute Moshi" : "Unmute Moshi"}
          onClick={() => toggleVoice()}>{voiceOn ? "🔊" : "🔇"}</button>
      </div>
      <div ref={hostRef} className="moshi-mount" data-testid="moshi" title="Moshi — poke him"
        tabIndex={0} role="img" aria-label="Moshi, the agent creature"
        onClick={() => { try { apiRef.current?.poke?.(); } catch { /* noop */ } }} />
      <AgentComposer />
    </div>
  );
}
