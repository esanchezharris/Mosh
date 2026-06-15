// Hold-to-talk speech input. The whole point: voice produces TEXT that flows into
// the EXACT same pipe as typing — speaking is just a faster way to fill the
// composer, never a separate command path. So the brain/executor never know whether
// an ask was typed or spoken.
//
// In a browser (Vite dev / preview) this rides the Web Speech API
// (webkitSpeechRecognition). In the packaged JUCE WebView that API is typically
// absent, so isVoiceSupported() returns false and the UI keeps the mic disabled and
// falls back to typing (the "quiet type fallback"). A native whisper STT is the
// future packaged-app path — it would feed onFinal() identically, mirroring the
// native brain_chat proxy. Nothing downstream changes.

import { nativeVoiceAvailable, voiceStart, voiceStop, onEvent } from "../bridge";

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
 *  backend so the composer is identical. */
function createNativeVoiceInput(cb: VoiceCallbacks): VoiceInput {
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
    void voiceStart().catch(() => { listening = false; teardown(); cb.onError?.("voice start failed"); });
  };
  const stop = () => { if (listening) void voiceStop().catch(() => { /* noop */ }); };
  const abort = () => { listening = false; teardown(); void voiceStop().catch(() => { /* noop */ }); };

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
