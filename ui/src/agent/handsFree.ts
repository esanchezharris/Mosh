// The hands-free listening controller — the explicit FSM the user asked for.
//
// Two states only: OFF (not engaged) and LISTENING (engaged, mic hot). It owns the
// lifetime of a CONTINUOUS voice source and routes every finalized transcript through
// the SAME deterministic matcher the composer uses (matchFastPath) → handleFast,
// DROPPING anything that doesn't match. It never touches the LLM brain — an unknown
// utterance is silently ignored. This is what makes an always-hot mic safe: only the
// fixed, state-gated performer/transport phrases can ever act.
//
// The performer modes (idle | recording | reviewing) are NOT duplicated here — the
// controller reads `getCtx().mode` live on every utterance, so "stop" / "keep that"
// resolve against whatever the take loop is doing right now (= barge-in). Pure and
// dependency-injected (like performer.ts) so it unit-tests with zero store/bridge.

import { matchFastPath, type FastAction, type FastCtx } from "./fastPath";
import type { VoiceCallbacks, VoiceInput } from "./voiceInput";

export type HandsFreeDeps = {
  /** Live session context for the matcher (mode/tempo/timeSig), read per-utterance. */
  getCtx: () => FastCtx;
  /** Is a command already in flight (typed / hold-to-talk / a prior hands-free hit)? */
  isBusy: () => boolean;
  /** Bracket each dispatch with the shared busy flag so two utterances can't interleave. */
  setBusy: (b: boolean) => void;
  /** Run a matched action (wraps handleFast with its FastDeps). */
  dispatch: (action: FastAction) => Promise<void>;
  /** Build a CONTINUOUS voice source for these callbacks (null = no speech backend). */
  makeSource: (cb: VoiceCallbacks) => VoiceInput | null;
  /** Reflect the hot-mic indicator. */
  setListening: (b: boolean) => void;
  /** Surface a fatal recognizer error (optional). */
  onError?: (msg: string) => void;
  /** Injectable clock for the dedupe window (defaults to Date.now). */
  now?: () => number;
};

export type HandsFree = {
  engage: () => void;
  disengage: () => void;
  readonly engaged: boolean;
};

// Continuous ASR re-emits the same endpointed phrase in quick succession; collapse an
// identical final inside this window so one spoken command fires exactly once.
const DEDUPE_MS = 700;

export function createHandsFree(deps: HandsFreeDeps): HandsFree {
  const now = deps.now ?? (() => Date.now());
  let engaged = false;
  let source: VoiceInput | null = null;
  let lastText = "";
  let lastAt = Number.NEGATIVE_INFINITY;

  const handleFinal = async (raw: string): Promise<void> => {
    if (!engaged) return;
    const text = raw.trim();
    if (!text) return;
    if (deps.isBusy()) return; // a command is mid-flight — drop (a stale "stop" later is worse)
    const t = now();
    if (text === lastText && t - lastAt < DEDUPE_MS) return; // duplicate final → collapse
    lastText = text;
    lastAt = t;
    const action = matchFastPath(text, deps.getCtx());
    if (!action) return; // unknown phrase — ignore; NEVER falls through to the brain
    deps.setBusy(true);
    try {
      await deps.dispatch(action);
    } catch {
      /* a failed command must not wedge the listener */
    } finally {
      deps.setBusy(false);
    }
  };

  const engage = (): void => {
    if (engaged) return;
    engaged = true;
    source = deps.makeSource({
      onStart: () => deps.setListening(true),
      onStop: () => deps.setListening(false),
      // The async handler's promise is assignable to the void slot; returning it lets
      // tests await completion (and is harmless in production).
      onFinal: (t) => handleFinal(t),
      onError: (e) => { deps.setListening(false); deps.onError?.(e); },
    });
    if (!source) { engaged = false; return; } // no backend → stay OFF
    source.start();
  };

  const disengage = (): void => {
    if (!engaged) return;
    engaged = false;
    source?.abort(); // abort() (not stop()) so the continuous source won't auto-restart
    source = null;
    deps.setListening(false);
  };

  return { engage, disengage, get engaged() { return engaged; } };
}
