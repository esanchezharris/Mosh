// The composer that lives in Moshi's rail. You ask — by holding the mic to TALK
// (voice-hero) or by typing (the quiet fallback) — his brain plans, the executor
// runs the edits as ONE undo step, and the result lands in Monster changes. Voice
// and text feed the very same run() funnel; nothing downstream knows the difference.

import { useRef, useState, useEffect } from "react";
import { useStore } from "../store";
import { createBrain, type Brain } from "../agent/brain";
import { runAgentBatch } from "../agent/executor";
import { matchFastPath } from "../agent/fastPath";
import { handleFast } from "../agent/performer";
import { createVoiceInput, createContinuousVoiceInput, isVoiceSupported, type VoiceInput } from "../agent/voiceInput";
import { createHandsFree, type HandsFree } from "../agent/handsFree";

// Hands-free always-on listening. Owns the lifetime of the CONTINUOUS recognizer:
// engages when the `handsFreeOn` toggle is true (and the tab is visible), disengages
// otherwise. Every final transcript routes through the SAME matcher/performer as the
// composer — but DROPS anything unknown (never the brain). Returns pause/resume so
// hold-to-talk can temporarily own the mic for an open-ended (LLM) ask, then hand it
// back. The controller is pure; this hook is just its React lifecycle + store wiring.
function useHandsFree(): { pauseForPushToTalk: () => void; resumeAfterPushToTalk: () => void } {
  const handsFreeOn = useStore((s) => s.handsFreeOn);
  const ctrlRef = useRef<HandsFree | null>(null);
  const pausedRef = useRef(false);

  if (!ctrlRef.current) {
    ctrlRef.current = createHandsFree({
      getCtx: () => {
        const s = useStore.getState();
        return {
          mode: s.currentMode(),
          tempo: s.snapshot?.session?.tempo ?? 120,
          timeSigNum: s.snapshot?.session?.timeSigNumerator ?? 4,
        };
      },
      isBusy: () => useStore.getState().agentBusy,
      setBusy: (b) => useStore.getState().setAgentBusy(b),
      dispatch: async (action) => {
        const s = useStore.getState();
        await handleFast(action, {
          // hands-free voice turn: the transcript isn't threaded here, so the
          // utterance falls back to the action label; source is tagged "voice".
          runBatch: async (label, cmds) => { s.setAgentChangeSet(await runAgentBatch(label, cmds, { source: "voice" })); },
          enterRecord: s.enterRecord, stopRecord: s.stopRecord, keepTake: s.keepTake, navTake: s.navTake,
          utter: (intent, say) => { s.pushAgentUtter(intent, say); },
        });
      },
      makeSource: (cb) => createContinuousVoiceInput(cb),
      setListening: (b) => useStore.getState().setAgentListening(b),
    });
  }

  // Engage/disengage with the toggle (and tear down on unmount → mic goes cold).
  useEffect(() => {
    const ctrl = ctrlRef.current!;
    if (handsFreeOn) ctrl.engage(); else ctrl.disengage();
    return () => ctrl.disengage();
  }, [handsFreeOn]);

  // Defense-in-depth privacy: release the mic whenever the WebView is hidden.
  useEffect(() => {
    const onVis = () => {
      const ctrl = ctrlRef.current; if (!ctrl) return;
      if (document.hidden) ctrl.disengage();
      else if (useStore.getState().handsFreeOn && !pausedRef.current) ctrl.engage();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Fallback (opt-in): on inputs that can't be shared, pause hands-free WHILE a take
  // records and resume when it ends — the UI-driven alternative to barge-in. Off by
  // default (barge-in is the default), so this effect is inert unless enabled.
  const pauseOnRecord = useStore((s) => s.handsFreePauseOnRecord);
  const recording = useStore((s) => s.transport.recording);
  useEffect(() => {
    if (!handsFreeOn || !pauseOnRecord) return;
    const ctrl = ctrlRef.current; if (!ctrl) return;
    if (recording) ctrl.disengage(); else ctrl.engage();
  }, [handsFreeOn, pauseOnRecord, recording]);

  return {
    pauseForPushToTalk: () => {
      const ctrl = ctrlRef.current;
      if (ctrl?.engaged) { pausedRef.current = true; ctrl.disengage(); }
    },
    resumeAfterPushToTalk: () => {
      if (!pausedRef.current) return;
      pausedRef.current = false;
      if (useStore.getState().handsFreeOn) ctrlRef.current?.engage();
    },
  };
}

export function AgentComposer() {
  const agentBusy = useStore((s) => s.agentBusy);
  const setAgentBusy = useStore((s) => s.setAgentBusy);
  const setAgentChangeSet = useStore((s) => s.setAgentChangeSet);
  const pushAgentUtter = useStore((s) => s.pushAgentUtter);
  const setAgentListening = useStore((s) => s.setAgentListening);
  const [input, setInput] = useState("");
  const [say, setSay] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const brainRef = useRef<Brain | null>(null);
  if (!brainRef.current) brainRef.current = createBrain(() => useStore.getState().snapshot);

  const voiceSupported = isVoiceSupported();
  // undefined = not yet built; null = platform has no speech API.
  const voiceRef = useRef<VoiceInput | null | undefined>(undefined);
  const handsFree = useHandsFree();

  // The single funnel: typed text and final speech both arrive here.
  const run = async (text: string) => {
    if (!text || useStore.getState().agentBusy) return;
    setInput(""); setSay(null); setAgentBusy(true);
    try {
      // Deterministic fast path FIRST: an unambiguous, state-valid phrase runs locally
      // (no API). Anything ambiguous returns null and falls through to the LLM brain.
      const st = useStore.getState();
      const fast = matchFastPath(text, {
        mode: st.currentMode(),
        tempo: st.snapshot?.session?.tempo ?? 120,
        timeSigNum: st.snapshot?.session?.timeSigNumerator ?? 4,
      });
      if (fast) {
        await handleFast(fast, {
          runBatch: async (label, cmds) => { setAgentChangeSet(await runAgentBatch(label, cmds, { utterance: text, source: "fastpath" })); },
          enterRecord: st.enterRecord, stopRecord: st.stopRecord, keepTake: st.keepTake, navTake: st.navTake,
          utter: (intent, say) => { setSay(say ?? null); pushAgentUtter(intent, say); },
        });
        return;
      }
      const reply = await brainRef.current!.send(text);
      setSay(reply.say ?? null);
      pushAgentUtter(reply.intent ?? "ACK_GOT_IT", reply.say);
      if (reply.commands && reply.commands.length > 0) {
        const cs = await runAgentBatch(reply.say || text, reply.commands, { utterance: text, source: "brain_chat" });
        setAgentChangeSet(cs);
      }
    } catch {
      setSay("hmm — that broke");
      pushAgentUtter("UHOH");
    } finally {
      setAgentBusy(false);
    }
  };
  const submit = () => void run(input.trim());

  // Build the speech controller lazily on first press (after a user gesture, which
  // some browsers require). Final transcript auto-sends — release-to-send is the
  // voice-hero feel; interim text streams into the field so you see it forming.
  const ensureVoice = (): VoiceInput | null => {
    if (voiceRef.current === undefined) {
      voiceRef.current = createVoiceInput({
        onStart: () => { setListening(true); setAgentListening(true); setInput(""); },
        onInterim: (t) => setInput(t),
        onStop: () => { setListening(false); setAgentListening(false); handsFree.resumeAfterPushToTalk(); },
        onFinal: (t) => void run(t),
        onError: () => { setListening(false); setAgentListening(false); handsFree.resumeAfterPushToTalk(); setSay("didn't catch that"); },
      });
    }
    return voiceRef.current;
  };

  const micLabel = !voiceSupported ? "Voice unavailable here — type instead"
    : listening ? "Listening… release to send" : "Hold to talk";

  return (
    <div className="agent-composer">
      {say && <div className="agent-say" role="status" aria-live="polite">{say}</div>}
      <div className={`agent-input${listening ? " listening" : ""}`}>
        <button
          className={`agent-mic${listening ? " on" : ""}`}
          title={micLabel} aria-label={micLabel} aria-pressed={listening}
          disabled={!voiceSupported || agentBusy}
          data-testid="agent-mic"
          onPointerDown={(e) => {
            if (agentBusy || !voiceSupported) return;
            // Holding the talk button to address Moshi pauses always-on hands-free (so the
            // two recognizers never fight for the mic; it resumes on release) and STOPS an
            // in-progress take first (performer mode → assistant mode), then listens.
            handsFree.pauseForPushToTalk();
            if (useStore.getState().currentMode() === "recording") void useStore.getState().stopRecord();
            const v = ensureVoice(); if (!v) return;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
            v.start();
          }}
          onPointerUp={() => voiceRef.current?.stop()}
          onPointerCancel={() => voiceRef.current?.stop()}
        >
          <span aria-hidden="true">{listening ? "●" : "🎤"}</span>
        </button>
        <input
          data-testid="agent-input"
          value={input}
          placeholder={listening ? "listening…" : agentBusy ? "thinking…" : "Ask Moshi…"}
          disabled={agentBusy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <button className="agent-send" data-testid="agent-send" disabled={agentBusy || !input.trim()} onClick={submit} aria-label="Send to Moshi">
          <span aria-hidden="true">↑</span>
        </button>
      </div>
    </div>
  );
}
