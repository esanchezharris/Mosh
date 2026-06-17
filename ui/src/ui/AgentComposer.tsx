// The composer that lives in Moshi's rail. You ask — by holding the mic to TALK
// (voice-hero) or by typing (the quiet fallback) — his brain plans, the executor
// runs the edits as ONE undo step, and the result lands in Monster changes. Voice
// and text feed the very same run() funnel; nothing downstream knows the difference.

import { useRef, useState } from "react";
import { useStore } from "../store";
import { createBrain, type Brain } from "../agent/brain";
import { runAgentBatch } from "../agent/executor";
import { matchFastPath } from "../agent/fastPath";
import { handleFast } from "../agent/performer";
import { createVoiceInput, isVoiceSupported, type VoiceInput } from "../agent/voiceInput";

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
          runBatch: async (label, cmds) => { setAgentChangeSet(await runAgentBatch(label, cmds)); },
          enterRecord: st.enterRecord, stopRecord: st.stopRecord, keepTake: st.keepTake, navTake: st.navTake,
          utter: (intent, say) => { setSay(say ?? null); pushAgentUtter(intent, say); },
        });
        return;
      }
      const reply = await brainRef.current!.send(text);
      setSay(reply.say ?? null);
      pushAgentUtter(reply.intent ?? "ACK_GOT_IT", reply.say);
      if (reply.commands && reply.commands.length > 0) {
        const cs = await runAgentBatch(reply.say || text, reply.commands);
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
        onStop: () => { setListening(false); setAgentListening(false); },
        onFinal: (t) => void run(t),
        onError: () => { setListening(false); setAgentListening(false); setSay("didn't catch that"); },
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
            // Holding the talk button to address Moshi STOPS an in-progress take first
            // (performer mode → assistant mode), then listens.
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
