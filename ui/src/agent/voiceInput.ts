// Hold-to-talk speech input. The whole point: voice produces TEXT that flows into
// the EXACT same pipe as typing — speaking is just a faster way to fill the
// composer, never a separate command path. So the brain/executor never know whether
// an ask was typed or spoken.
//
// In a browser (Vite dev / preview) this rides the Web Speech API
// (webkitSpeechRecognition). In the packaged JUCE WebView that API is absent, so it
// falls back to native macOS speech (SFSpeechRecognizer) over the bridge —
// createNativeVoiceInput below, driven by voice_start / voice_stop and the
// voice_event channel (see WebBridge + NativeSpeech). Both backends feed onFinal()
// identically, so nothing downstream knows which produced the text. Only when neither
// backend exists does the mic stay disabled and the user types (the type fallback).

import { nativeVoiceAvailable, voiceStart, voiceStop, voiceListenStart, voiceListenStop, onEvent } from "../bridge";

// ── minimal Web Speech typings (the DOM lib's are not guaranteed present) ──────
interface SRAlternative { transcript: string }
interface SRResult { isFinal: boolean; 0: SRAlternative; length: number }
interface SRResultList { length: number; [i: number]: SRResult }
interface SREvent { resultIndex: number; results: SRResultList }
interface SRInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SRCtor = new () => SRInstance;

function getCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True where voice is available: the browser Web Speech API (Vite dev / Chromium)
 *  OR the packaged app's native macOS speech. Drives whether the composer's mic is
 *  live or a disabled hint. (Native support is confirmed for real on the first hold;
 *  an unsupported/unauthorized native session surfaces via onError, like the web path.) */
export function isVoiceSupported(): boolean {
  return getCtor() !== null || nativeVoiceAvailable();
}

export type VoiceCallbacks = {
  onStart?: () => void;          // recognition began (mic is hot)
  onInterim?: (text: string) => void; // live partial transcript while holding
  onFinal?: (text: string) => void;   // committed transcript once released
  onStop?: () => void;           // recognition ended (any reason)
  onError?: (err: string) => void;
};

export type VoiceInput = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  readonly listening: boolean;
};

/** Native (packaged-app) backend: drives macOS Speech through the bridge. Transcripts
 *  arrive on the "voice_event" channel; we map them to the same callbacks as the web
 *  backend so the composer is identical. The event handling is mode-agnostic — it keeps
 *  the subscription open across `final`s and only ends on `stop`/`error` — so passing
 *  `continuous` simply selects the always-on bridge pair (voice_listen_*) vs the
 *  single-shot one (voice_*); a continuous session then yields many finals, hold-to-talk
 *  yields one then stops. */
function createNativeVoiceInput(cb: VoiceCallbacks, continuous = false): VoiceInput {
  const startFn = continuous ? voiceListenStart : voiceStart;
  const stopFn  = continuous ? voiceListenStop  : voiceStop;
  let listening = false;
  let unsub: (() => void) | null = null;
  const teardown = () => { if (unsub) { unsub(); unsub = null; } };

  const start = () => {
    if (listening) return;
    listening = true;
    unsub = onEvent("voice_event", (raw) => {
      const ev = raw as { type?: string; text?: string };
      const text = (ev.text ?? "").replace(/\s+/g, " ").trim();
      switch (ev.type) {
        case "start": cb.onStart?.(); break;
        case "interim": cb.onInterim?.(text); break;
        case "final": cb.onFinal?.(text); break;
        case "stop": listening = false; teardown(); cb.onStop?.(); break;
        case "error": listening = false; teardown(); cb.onError?.(text || "voice error"); break;
      }
    });
    void startFn().catch(() => { listening = false; teardown(); cb.onError?.("voice start failed"); });
  };
  const stop = () => { if (listening) void stopFn().catch(() => { /* noop */ }); };
  const abort = () => { listening = false; teardown(); void stopFn().catch(() => { /* noop */ }); };

  return { start, stop, abort, get listening() { return listening; } };
}

/** Build a hold-to-talk controller, or null if the platform has no speech backend.
 *  start() on press, stop() on release; the final transcript arrives via onFinal.
 *  Prefers the browser Web Speech API (dev); falls back to native macOS speech. */
export function createVoiceInput(cb: VoiceCallbacks): VoiceInput | null {
  const Ctor = getCtor();
  if (!Ctor) return nativeVoiceAvailable() ? createNativeVoiceInput(cb) : null;

  let rec: SRInstance | null = null;
  let listening = false;
  let finalText = "";

  const clean = (s: string) => s.replace(/\s+/g, " ").trim();

  const start = () => {
    if (listening) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    finalText = "";

    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res?.[0]?.transcript ?? "";
        if (res?.isFinal) finalText += txt;
        else interim += txt;
      }
      cb.onInterim?.(clean(finalText + interim));
    };
    r.onerror = (e) => { cb.onError?.(e?.error ?? "speech-error"); };
    r.onend = () => {
      listening = false; rec = null;
      cb.onStop?.();
      const t = clean(finalText);
      if (t) cb.onFinal?.(t);
    };

    rec = r;
    try { r.start(); listening = true; cb.onStart?.(); }
    catch (err) { listening = false; rec = null; cb.onError?.(String(err)); }
  };

  const stop = () => { if (rec && listening) { try { rec.stop(); } catch { /* noop */ } } };
  const abort = () => { if (rec) { try { rec.abort(); } catch { /* noop */ } } listening = false; rec = null; };

  return { start, stop, abort, get listening() { return listening; } };
}

// Error codes that mean the mic is genuinely unavailable (permission denied / no
// device) — these must STOP, not hot-loop a re-arm. Everything else (e.g. "no-speech",
// "aborted", "network") is routine for a long always-on session: let onend re-arm.
const FATAL_SR_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

/** Build an ALWAYS-ON (continuous) speech controller for hands-free mode, or null if
 *  the platform has no speech backend. Unlike createVoiceInput (hold-to-talk), this:
 *   • fires onFinal PER endpointed phrase, not once on release, and
 *   • auto-restarts after the recognizer self-stops (Chromium ends on silence even with
 *     continuous=true), so the mic stays hot until stop()/abort().
 *  Same VoiceCallbacks/VoiceInput contract, so the hands-free controller is identical
 *  across web (dev) and native (packaged app reuses createNativeVoiceInput, whose
 *  continuous semantics — repeated finals until an explicit stop — already match). */
export function createContinuousVoiceInput(cb: VoiceCallbacks): VoiceInput | null {
  const Ctor = getCtor();
  // Packaged app (no Web Speech): drive the NATIVE continuous recognizer (voice_listen_*).
  if (!Ctor) return nativeVoiceAvailable() ? createNativeVoiceInput(cb, /*continuous=*/ true) : null;

  let rec: SRInstance | null = null;
  let engaged = false; // governs auto-restart; cleared by stop()/abort()/fatal error
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();

  // Arm a FRESH recognizer instance (a new one per cycle — restarting a finished
  // SRInstance is unreliable across browsers) and start it. onStart is NOT fired here:
  // the mic is "hot" for the whole engaged span, signalled once in start().
  const arm = () => {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";

    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res?.[0]?.transcript ?? "";
        if (res?.isFinal) { const f = clean(txt); if (f) cb.onFinal?.(f); } // each phrase fires immediately
        else interim += txt;
      }
      const live = clean(interim);
      if (live) cb.onInterim?.(live);
    };
    r.onerror = (e) => {
      const code = e?.error ?? "speech-error";
      if (FATAL_SR_ERRORS.has(code)) { engaged = false; cb.onError?.(code); } // stop; don't re-arm
      // transient errors are swallowed — onend will fire next and re-arm
    };
    r.onend = () => {
      rec = null;
      if (engaged) arm();           // self-stopped on silence → keep listening
      else cb.onStop?.();           // intentional stop → mic is now cold
    };

    rec = r;
    try { r.start(); }
    catch (err) { engaged = false; rec = null; cb.onError?.(String(err)); }
  };

  const start = () => {
    if (engaged) return;
    engaged = true;
    cb.onStart?.();                 // hot once for the whole session, not per internal re-arm
    arm();
  };
  const stop = () => { engaged = false; if (rec) { try { rec.stop(); } catch { /* noop */ } } };
  const abort = () => { engaged = false; if (rec) { try { rec.abort(); } catch { /* noop */ } } };

  return { start, stop, abort, get listening() { return engaged; } };
}
