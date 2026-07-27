// Moshi — the agent character (the design-lab keeper), mounted as a presence and
// now ALIVE in the product: he swells with the live mix, perks up when playback
// starts, burbles while a render runs, and celebrates a landed take — all through
// his own semantic drives + a non-verbal voice. NOTHING engine-specific crosses
// into moshi.js (HOUSE_STYLE §21 — the seam stays swappable); the host only feeds
// scalars derived from store events (levels / transport / render).

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { useIsV2 } from "../v2/shellFlag";
import { DEFAULT_KEY } from "../musicalKey";
import { AgentComposer } from "./AgentComposer";
import { IconListen, IconSpeaker, IconSpeakerMute } from "./icons";
import "../vendor/moshi.js";
import "../vendor/voice.js";

type MoshiApi = {
  set: (k: string, v: number) => MoshiApi;
  setState: (s: string) => MoshiApi;
  setPose: (n: string, hold?: number) => MoshiApi;
  setStyle: (s: string) => MoshiApi;
  setQuality: (q: string) => MoshiApi;
  setPersonality: (n: string | number, seed?: number, o?: object) => MoshiApi;
  setAnatomy: (n: string) => MoshiApi;
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

  const playing = useStore((s) => s.transport.playing);
  const recording = useStore((s) => s.transport.recording);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const celebrateTick = useStore((s) => s.celebrateTick);
  const voiceOn = useStore((s) => s.voiceOn);
  const qaByClip = useStore((s) => s.qaByClip);
  // Song key — drives his in-key voice. The store refetches the whole snapshot on
  // snapshot_invalidated, so these update reactively when set_key lands.
  const keyTonic = useStore((s) => s.snapshot?.session.key?.tonic ?? DEFAULT_KEY.tonic);
  const keyMode = useStore((s) => s.snapshot?.session.key?.mode ?? DEFAULT_KEY.mode);

  // ── mount once: moshi + voice + the funnel + energy loop + first-open greet ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.Moshi !== "function") return;
    let api: MoshiApi | null = null;
    try {
      // Doctrine resolution policy lives INSIDE moshi.js now: buffer = CSS px /
      // quality div on every display (never DPR-multiplied), nearest-pixelated
      // upscale when stretched. The old de-crunching pair (resDiv:1 here +
      // image-rendering:auto in mosh.css) is gone — the crunch is identity.
      api = window.Moshi(host, { personality: "TAR", seed: 0.5 });
      api.setQuality("ps2");
      api.setAnatomy("A"); // baked anatomy pick (the lab's chosen 3D-vs-flat balance)
      apiRef.current = api;
    } catch { apiRef.current = null; }

    // voice (Web Audio) — guarded so a missing AudioContext can never break the UI
    try {
      if (typeof window.MoshiVoice === "function") {
        const v = window.MoshiVoice({ master: 0.55, enabled: useStore.getState().voiceOn });
        // Initialise from the snapshot's musical key (always present + defaulted on
        // the backend). The reactive effect below re-applies it when the key changes.
        const k = useStore.getState().snapshot?.session.key ?? DEFAULT_KEY;
        v.setKey(k.tonic, k.mode);
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

    // Moshi reacts to the LIVE SPECTRUM — a rAF loop reads the 30 Hz master Goertzel
    // feed TRANSIENTLY (getState, no re-render) and integrates it into smoothed body
    // scalars: bass + overall level swell his ENERGY (a flux transient adds a beat
    // kick), treble drives HEAT (recording pins it hot). Idle settles to a slow breath
    // so he's never fully still. O(1) per frame, no allocation.
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    const avg = (a: number[]) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);
    let raf = 0, energy = 0, heat = 0, breathPhase = 0, lastDuck = -1;
    const tick = () => {
      const m = apiRef.current;
      if (m) {
        const st = useStore.getState();
        const spec = st.spectrum;
        const bands = spec.bands ?? [];
        const low = avg(bands.slice(0, 3));
        const high = avg(bands.slice(Math.max(0, bands.length - 3)));
        const isPlaying = st.transport.playing;
        const isRec = st.transport.recording;
        breathPhase += 0.018;
        const breath = 0.12 + 0.05 * Math.sin(breathPhase);
        const energyT = clamp((isPlaying ? 0.25 + 0.7 * (0.55 * low + 0.45 * spec.level) : breath) + spec.flux * 0.3);
        const heatT = clamp(isRec ? 0.9 : 0.1 + 0.5 * high);
        energy += (energyT - energy) * 0.15;
        heat += (heatT - heat) * 0.12;
        try {
          m.set("energy", energy);
          m.set("heat", heat);
          // duck the voice under a loud mix so his coos sit below the music
          const v = voiceRef.current;
          if (v) {
            const duck = isPlaying && energy > 0.4 ? 0.45 : 1;
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

    // long-period idle nudge — a silent host glance every 45–90s, ONLY when nothing
    // is happening (not playing/recording/rendering). It just re-aims his gaze, which
    // moshi.js eases on its own; moshi.js's built-in idle ladder carries the rest.
    // setTimeout-driven (no rAF loop), so it can't masquerade as a dropped frame.
    let nudgeT = 0;
    const scheduleNudge = () => {
      nudgeT = window.setTimeout(() => {
        const st = useStore.getState();
        const busy = st.transport.playing || st.transport.recording
          || Object.keys(st.renderProgress).length > 0;
        if (!busy) {
          try { apiRef.current?.lookAt((Math.random() * 2 - 1) * 0.5, (Math.random() * 2 - 1) * 0.3); } catch { /* noop */ }
        }
        scheduleNudge();
      }, 45000 + Math.random() * 45000);
    };
    scheduleNudge();

    // pause battery/CPU when the window is hidden
    const onVis = () => {
      if (document.hidden) { cancelAnimationFrame(raf); }
      else { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(greetT);
      clearTimeout(nudgeT);
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

  // ── voice key follows the session's musical key (set_key → snapshot.session.key)─
  useEffect(() => { try { voiceRef.current?.setKey(keyTonic, keyMode); } catch { /* noop */ } }, [keyTonic, keyMode]);

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
  const handsFreeOn = useStore((s) => s.handsFreeOn);
  const setHandsFree = useStore((s) => s.setHandsFree);
  // In the redesign AND v2 shells the prompt lives in a dedicated bottom bar, so it's
  // not mounted here — mounted in exactly one place either way (no double mount). Only
  // the classic non-redesign layout owns the composer inside Moshi's dock.
  const redesign = useSettings((s) => Boolean(s.get("redesignShell")));
  const inV2 = useIsV2();
  const ownComposer = !redesign && !inV2;
  const stateLabel = recording ? "● rec" : rendering ? "working…" : playing ? "listening" : "idle";
  // One-word mood derived from the same live state. `mood` keys the mount's
  // state-tinted glow (box-shadow only — no transform/filter on the canvas wrapper);
  // `moodWord` exercises the new display font in the cap.
  const mood = recording ? "rec" : rendering ? "work" : playing ? "listen" : "idle";
  const moodWord = recording ? "rec" : rendering ? "cook" : playing ? "vibe" : "chill";

  // Fixed dock panel (lives at the right of the bottom dock, by the generative
  // drawer — where his reactions happen). Not floating, not draggable.
  return (
    <div className="moshi-dock" data-testid="moshi-stage">
      <div className="moshi-cap">
        <span className="moshi-state tc">{stateLabel}</span>
        {/* Hands-free always-on listening. ON = mic hot, command phrases act without
            holding the talk button. The `on` class + agentListening pulse the 👂. */}
        <button className={`moshi-handsfree${handsFreeOn ? " on" : ""}${handsFreeOn && agentListening ? " hot" : ""}`}
          data-testid="moshi-handsfree" aria-pressed={handsFreeOn}
          title={handsFreeOn ? "Hands-free listening on — tap to turn off" : "Hands-free listening off — tap for always-on voice"}
          aria-label={handsFreeOn ? "Turn off hands-free listening" : "Turn on hands-free listening"}
          onClick={() => setHandsFree(!handsFreeOn)}><IconListen size={15} /></button>
        <button className="moshi-mute" data-testid="moshi-mute" aria-pressed={!voiceOn}
          title={voiceOn ? "Mute Moshi" : "Unmute Moshi"} aria-label={voiceOn ? "Mute Moshi" : "Unmute Moshi"}
          onClick={() => toggleVoice()}>{voiceOn ? <IconSpeaker size={15} /> : <IconSpeakerMute size={15} />}</button>
        <span className="moshi-handsfree-status" role="status" aria-live="polite" data-testid="handsfree-status">
          {handsFreeOn ? "hands-free on" : ""}
        </span>
      </div>
      {/* data-mood drives ONLY a box-shadow tint on this canvas wrapper (HARD RULE:
          never transform/filter the live-GL .moshi-mount). */}
      <div ref={hostRef} className="moshi-mount" data-testid="moshi" data-mood={mood} title="Moshi — poke him"
        tabIndex={0} role="img" aria-label="Moshi, the agent creature"
        onClick={() => { try { apiRef.current?.poke?.(); } catch { /* noop */ } }} />
      {/* data-celebrate flips parity each accept (celebrateTick) so the CSS bounce
          re-triggers exactly on the reward, not on every render. NON-canvas element. */}
      <span className="moshi-mood display" data-mood={mood}
        data-celebrate={celebrateTick > 0 ? (celebrateTick % 2 === 0 ? "a" : "b") : "off"}
        data-testid="moshi-mood">{moodWord}</span>
      {ownComposer && <AgentComposer />}
    </div>
  );
}
