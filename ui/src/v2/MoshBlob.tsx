// MoshBlob — the minimized Moshi: a glossy 5-petal splat with a "> <" squint and a big
// open singing mouth (the concept art). Pure SVG + CSS-var animation — NO WebGL — so the
// v2 bundle no longer pulls in vendor/moshi.js. He stays ALIVE: the body breathes, the
// mouth opens and sings with the live mix, the eyes blink and squint, and he bounces when
// a take lands. The look themes itself via --v2-blob-* tokens (pale glossy on the dark
// hero, dark glossy on cream); the mouth keeps the brand lime in both.
//
// Liveness is self-contained (the GL Moshi in ui/Moshi.tsx is untouched, still used by the
// classic/redesign shells + the ?view=character-lab lab route). A single rAF reads the
// store TRANSIENTLY (getState — no re-render, no alloc) and writes CSS custom properties,
// exactly the cheap pattern Moshi.tsx uses. The R2-D2 voice (window.MoshiVoice) is kept —
// it's independent of the canvas — and funnels the same intents as before.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { DEFAULT_KEY } from "../musicalKey";
import "../vendor/voice.js"; // attaches window.MoshiVoice (no moshi.js — that's the GL char)

type Affect = { valence?: number; arousal?: number };
type VoiceApi = {
  unlock: () => void;
  play: (intent: string, o?: object) => unknown;
  startLoop: (intent: string, o?: object) => VoiceApi;
  stopLoop: () => VoiceApi;
  setEnabled: (b: boolean) => VoiceApi;
  setMaster: (v: number) => VoiceApi;
  setKey: (name: string | number, mode?: string, octave?: number) => VoiceApi;
  destroy: () => VoiceApi;
};

// He greets once per session — module-scoped so a dock collapse/expand remount can't
// re-trigger the hello (mirrors Moshi.tsx).
let hasGreetedThisSession = false;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const avg = (a: number[]) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);

export function MoshBlob({ size = 168, voice = true, className, mini = false }:
  { size?: number; voice?: boolean; className?: string; mini?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const voiceRef = useRef<VoiceApi | null>(null);
  const workingLoop = useRef(false);

  // ── visual life: one rAF, CSS-vars only (runs in BOTH the full + mini mounts) ──
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      // settle to a calm static smile — still expressive, just not animated
      root.style.setProperty("--mosh-eye", "1");
      root.style.setProperty("--mosh-mouth", "0.5");
      return;
    }

    let raf = 0;
    let energy = 0, mouth = 0.3, eye = 1, bob = 0, scale = 1, rec = 0, gx = 0, gy = 0;
    let gazeTX = 0, gazeTY = 0, nextGaze = 0, blinkUntil = 0, nextBlink = 0, celebrateUntil = 0;
    let prevCelebrate = useStore.getState().celebrateTick;
    let breath = Math.random() * 6.283;
    const t0 = performance.now();

    const tick = (now: number) => {
      const st = useStore.getState();
      const spec = st.spectrum;
      const bands = spec.bands ?? [];
      const low = avg(bands.slice(0, 3));
      const playing = st.transport.playing;
      const recording = st.transport.recording;
      const rendering = Object.keys(st.renderProgress).length > 0;
      const tsec = (now - t0) / 1000;

      breath += 0.018;
      const breathV = 0.5 + 0.5 * Math.sin(breath);

      // energy: the live mix swells him; idle settles to a slow breath
      const energyT = clamp01(playing ? 0.3 + 0.7 * (0.55 * low + 0.45 * spec.level) + spec.flux * 0.3
        : recording ? 0.45 : 0.12 + 0.06 * breathV);
      energy += (energyT - energy) * 0.16;

      // celebrate spike (a landed take): boost mouth + a little bounce for ~0.9s
      if (st.celebrateTick !== prevCelebrate) { prevCelebrate = st.celebrateTick; celebrateUntil = now + 900; }
      const celebrating = now < celebrateUntil;
      const celAmt = celebrating ? clamp01((celebrateUntil - now) / 900) : 0;

      // mouth: sings with energy while playing/recording; a small "o" at rest; wide on celebrate
      const mouthT = clamp01((playing || recording ? 0.45 + 0.55 * energy : rendering ? 0.3 + 0.15 * breathV
        : 0.22 + 0.05 * breathV) + 0.5 * celAmt);
      mouth += (mouthT - mouth) * 0.22;

      // eyes: blink occasionally; squint a touch when energetic/celebrating
      if (now > nextBlink) { blinkUntil = now + 120; nextBlink = now + 2600 + Math.random() * 4200; }
      const blinking = now < blinkUntil;
      const squint = 0.45 * clamp01(energy * 1.2) + 0.3 * celAmt;
      const eyeT = blinking ? 0.12 : clamp01(1 - squint);
      eye += (eyeT - eye) * (blinking ? 0.55 : 0.2);

      // idle gaze drift — re-aim every few seconds when nothing's happening
      if (now > nextGaze) {
        const busy = playing || recording || rendering;
        gazeTX = busy ? 0 : (Math.random() * 2 - 1) * 2.4;
        gazeTY = busy ? 0 : (Math.random() * 2 - 1) * 1.4;
        nextGaze = now + 1800 + Math.random() * 2600;
      }
      gx += (gazeTX - gx) * 0.05; gy += (gazeTY - gy) * 0.05;

      // breathing bob + scale; a celebrate hop rides on top
      const bobT = -1.4 * breathV - 2.2 * energy + (celebrating ? -3 * Math.abs(Math.sin(tsec * 14)) * celAmt : 0);
      const scaleT = 1 + 0.012 * breathV + 0.03 * energy + 0.04 * celAmt;
      bob += (bobT - bob) * 0.12; scale += (scaleT - scale) * 0.12;

      const recT = recording ? 1 : 0; rec += (recT - rec) * 0.1;

      root.style.setProperty("--mosh-eye", eye.toFixed(3));
      root.style.setProperty("--mosh-mouth", mouth.toFixed(3));
      root.style.setProperty("--mosh-bob", bob.toFixed(2));
      root.style.setProperty("--mosh-scale", scale.toFixed(3));
      root.style.setProperty("--mosh-rec", rec.toFixed(3));
      root.style.setProperty("--mosh-gx", gx.toFixed(2));
      root.style.setProperty("--mosh-gy", gy.toFixed(2));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // ── voice + intent funnel (the audible character) — only on the primary mount ──
  const playing = useStore((s) => s.transport.playing);
  const recording = useStore((s) => s.transport.recording);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const celebrateTick = useStore((s) => s.celebrateTick);
  const voiceOn = useStore((s) => s.voiceOn);
  const qaByClip = useStore((s) => s.qaByClip);
  const agentUtter = useStore((s) => s.agentUtter);
  const keyTonic = useStore((s) => s.snapshot?.session.key?.tonic ?? DEFAULT_KEY.tonic);
  const keyMode = useStore((s) => s.snapshot?.session.key?.mode ?? DEFAULT_KEY.mode);
  const utterRef = useRef<(intent: string, o?: { affect?: Affect; seed?: number }) => void>(() => {});

  useEffect(() => {
    if (!voice) return;
    const VoiceFactory = (window as unknown as { MoshiVoice?: (o?: object) => VoiceApi }).MoshiVoice;
    try {
      if (typeof VoiceFactory === "function") {
        const v = VoiceFactory({ master: 0.55, enabled: useStore.getState().voiceOn });
        const k = useStore.getState().snapshot?.session.key ?? DEFAULT_KEY;
        v.setKey(k.tonic, k.mode);
        voiceRef.current = v;
      }
    } catch { voiceRef.current = null; }

    utterRef.current = (intent, o = {}) => {
      const v = voiceRef.current; if (!v) return;
      try {
        v.unlock();
        if (intent === "ACK_WORKING") { v.startLoop(intent, { affect: o.affect }); workingLoop.current = true; }
        else {
          if (workingLoop.current) { v.stopLoop(); workingLoop.current = false; }
          v.play(intent, { affect: o.affect, seed: o.seed });
        }
      } catch { /* noop */ }
    };

    // an AudioContext may only start inside a user gesture — prime once
    const prime = () => { try { voiceRef.current?.unlock(); } catch { /* noop */ } };
    window.addEventListener("pointerdown", prime, { capture: true, once: true });
    window.addEventListener("keydown", prime, { capture: true, once: true });

    const greetT = window.setTimeout(() => {
      if (hasGreetedThisSession) return;
      hasGreetedThisSession = true;
      utterRef.current("GREET", { affect: { valence: 0.8, arousal: 0.7 } });
    }, 700);

    return () => {
      clearTimeout(greetT);
      window.removeEventListener("pointerdown", prime, true);
      window.removeEventListener("keydown", prime, true);
      try { voiceRef.current?.destroy(); } catch { /* noop */ }
      voiceRef.current = null;
    };
  }, [voice]);

  // burble while rendering, exhale when it resolves
  const wasRendering = useRef(false);
  useEffect(() => {
    if (!voice) return;
    if (rendering && !wasRendering.current) utterRef.current("ACK_WORKING", { affect: { valence: 0.1, arousal: 0.4 } });
    else if (!rendering && wasRendering.current) { try { voiceRef.current?.stopLoop(); } catch { /* noop */ } workingLoop.current = false; }
    wasRendering.current = rendering;
  }, [rendering, voice]);

  // the reward: a take landed (accept_render bumps celebrateTick)
  useEffect(() => { if (voice && celebrateTick > 0) utterRef.current("DONE", { affect: { valence: 0.9, arousal: 0.9 } }); }, [celebrateTick, voice]);

  // commiserate on a degraded render (once per new flag set)
  const seenDegraded = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!voice) return;
    for (const [clipId, qa] of Object.entries(qaByClip)) {
      const flags = qa?.flags ?? [];
      if (!flags.includes("quality_degraded")) continue;
      const key = clipId + ":" + flags.join(",");
      if (seenDegraded.current.has(key)) continue;
      seenDegraded.current.add(key);
      utterRef.current("UHOH", { affect: { valence: -0.6, arousal: 0.5 } });
    }
  }, [qaByClip, voice]);

  // react to the agent's reply, follow the voice toggle + the session key
  useEffect(() => { if (voice && agentUtter) utterRef.current(agentUtter.intent, { affect: { valence: 0.6, arousal: 0.6 } }); }, [agentUtter, voice]);
  useEffect(() => { if (voice) try { voiceRef.current?.setEnabled(voiceOn); } catch { /* noop */ } }, [voiceOn, voice]);
  useEffect(() => { if (voice) try { voiceRef.current?.setKey(keyTonic, keyMode); } catch { /* noop */ } }, [keyTonic, keyMode, voice]);

  const state = recording ? "rec" : rendering ? "work" : playing ? "play" : "idle";

  return (
    <div
      ref={rootRef}
      className={`v2-blob${mini ? " mini" : ""}${className ? ` ${className}` : ""}`}
      data-testid="v2-mosh"
      data-state={state}
      style={{ width: size, height: size }}
      role="img"
      aria-label="Moshi, the agent"
    >
      <svg viewBox="-10 -10 140 140" width="100%" height="100%" aria-hidden="true">
        <defs>
          <linearGradient id="moshBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--v2-blob-1, #f4f4ee)" />
            <stop offset="1" stopColor="var(--v2-blob-2, #d2d2cb)" />
          </linearGradient>
        </defs>
        <g className="v2-blob-all">
          {/* the 5-petal splat body (smooth quadratic lobes) */}
          <path
            className="v2-blob-shape"
            d="M80 32.5 Q122.8 39.6 92.3 70.5 Q98.8 113.4 60 94 Q21.2 113.4 27.7 70.5 Q-2.8 39.6 40 32.5 Q60 -6 80 32.5 Z"
            fill="url(#moshBody)"
          />
          {/* soft gloss highlight strokes */}
          <g className="v2-blob-hi" fill="none" stroke="var(--v2-blob-hi, rgba(255,255,255,0.5))" strokeWidth="1.4" strokeLinecap="round">
            <path d="M34 30 Q44 22 62 23" />
            <path d="M30 52 Q34 64 44 70" />
          </g>
          <g className="v2-blob-face">
            <g className="v2-blob-eyes" fill="none" stroke="var(--v2-blob-ink, #15150f)" strokeWidth="5.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="50,52 57,58.5 50,65" />
              <polyline points="70,52 63,58.5 70,65" />
            </g>
            <g className="v2-blob-mouth">
              <path className="v2-blob-mouth-fill" d="M47 72 L73 72 A13 13 0 0 1 47 72 Z" fill="var(--v2-blob-mouth, var(--v2-accent))" />
              <ellipse className="v2-blob-throat" cx="60" cy="83" rx="6" ry="4.6" fill="var(--v2-blob-throat, #15150f)" />
              <ellipse className="v2-blob-mouth-hi" cx="56.5" cy="81.5" rx="2" ry="1.3" fill="#fff" opacity="0.5" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
