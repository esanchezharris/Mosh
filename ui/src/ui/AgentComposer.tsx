// The composer that lives in Moshi's rail. You ask — by holding the mic to TALK
// (voice-hero) or by typing (the quiet fallback) — his brain plans, the executor
// runs the edits as ONE undo step, and the result lands in Monster changes. Voice
// and text feed the very same run() funnel; nothing downstream knows the difference.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { createBrain, type Brain } from "../agent/brain";
import { runAgentBatch } from "../agent/executor";
import { commandNeedsConfirm, describeCommand } from "../agent/commands";
import { createVoiceInput, isVoiceSupported, type VoiceInput } from "../agent/voiceInput";

const AFFIRM = /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go|confirm|please|aye)\b/i;

export function AgentComposer() {
  const agentBusy = useStore((s) => s.agentBusy);
  const setAgentBusy = useStore((s) => s.setAgentBusy);
  const setAgentChangeSet = useStore((s) => s.setAgentChangeSet);
  const pushAgentUtter = useStore((s) => s.pushAgentUtter);
  const setAgentListening = useStore((s) => s.setAgentListening);
  const refreshPluginList = useStore((s) => s.refreshPluginList);
  const [input, setInput] = useState("");
  const [say, setSay] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  // Make sure the brain knows what plugins are installed (for load-by-name).
  useEffect(() => {
    if (useStore.getState().availablePlugins.length === 0) void refreshPluginList();
  }, [refreshPluginList]);

  const brainRef = useRef<Brain | null>(null);
  if (!brainRef.current)
    brainRef.current = createBrain(
      () => useStore.getState().snapshot,
      () => useStore.getState().availablePlugins.map((p) => p.name),
    );

  const voiceSupported = isVoiceSupported();
  // undefined = not yet built; null = platform has no speech API.
  const voiceRef = useRef<VoiceInput | null | undefined>(undefined);

  // The single funnel: typed text and final speech both arrive here.
  const run = async (text: string) => {
    if (!text || useStore.getState().agentBusy) return;
    setInput("");

    // If a destructive command is parked, THIS utterance is the yes/no answer —
    // it never reaches the brain.
    const pending = useStore.getState().pendingConfirm;
    if (pending) {
      useStore.getState().setPendingConfirm(null);
      setAgentBusy(true);
      try {
        if (AFFIRM.test(text)) {
          const cs = await runAgentBatch(pending.label, pending.calls);
          setAgentChangeSet(cs); setSay("done"); pushAgentUtter("ACK_GOT_IT", "done");
        } else {
          setSay("ok, left it"); pushAgentUtter("NUH", "ok, left it");
        }
      } finally { setAgentBusy(false); }
      return;
    }

    setSay(null); setAgentBusy(true);
    try {
      const reply = await brainRef.current!.send(text);
      const all = reply.commands ?? [];
      const gated = all.filter((c) => commandNeedsConfirm(c.command, c.args ?? {}));
      const safe = all.filter((c) => !commandNeedsConfirm(c.command, c.args ?? {}));

      if (safe.length > 0) {
        const cs = await runAgentBatch(reply.say || text, safe);
        setAgentChangeSet(cs);
      }

      if (gated.length > 0) {
        const first = gated[0];
        const prompt = first.command === "export_audio" && first.args?.file
          ? `that overwrites ${String(first.args.file)} — say yes to go ahead`
          : `${describeCommand(first.command, first.args ?? {})} — say yes to confirm`;
        useStore.getState().setPendingConfirm({ calls: gated, label: reply.say || text, prompt });
        setSay(prompt); pushAgentUtter("HUH", prompt);
      } else {
        setSay(reply.say ?? null);
        pushAgentUtter(reply.intent ?? "ACK_GOT_IT", reply.say);
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
