// The composer that lives in Moshi's rail. You ask — by holding the mic to TALK
// (voice-hero) or by typing (the quiet fallback) — his brain plans, the executor
// runs the edits as ONE undo step, and the result lands in Monster changes. Voice
// and text feed the very same run() funnel; nothing downstream knows the difference.

import { useRef, useState, useEffect } from "react";
import { useStore } from "../store";
import { logAgentTurn, runAgentBatch } from "../agent/executor";
import { AgentHostUnavailableError } from "../agent/agentHost";
import { emitCapabilityTelemetry, executeDirectSafeCapabilities, isDirectSafeCall, recordCapabilityToolResult, requestCapabilitySupervisor } from "../agent/capabilityRuntime";
import { matchFastPath } from "../agent/fastPath";
import { handleFast } from "../agent/performer";
import { writePreference } from "../agent/memory/writePreference";
import { createVoiceInput, createContinuousVoiceInput, isVoiceSupported, type VoiceInput } from "../agent/voiceInput";
import { createHandsFree, type HandsFree } from "../agent/handsFree";
import { routeAsk } from "../agent/loop/router";
import { loopAllowed, runLoopTask } from "../agent/loop/runTask";
import { IconArrowUp, IconMic } from "./icons";
import { ownerCockpitRuntime, useOwnerCockpit } from "../agent/ownerCockpitRuntime";
import { classifyReportTrigger } from "../agent/ownerCockpit";
import { createOpenAIRealtimeController } from "../agent/openAIRealtime";
import { playMoshiEarcon, realtimeFallbackFor, type PushToTalkController } from "../agent/realtimeVoice";
import { useSettings } from "../settings/store";
import { createBrain } from "../agent/brain";

// Hands-free always-on listening. Owns the lifetime of the CONTINUOUS recognizer:
// engages when the `handsFreeOn` toggle is true (and the tab is visible), disengages
// otherwise. Every final transcript routes through the SAME matcher/performer as the
// composer — but DROPS anything unknown (never the brain). Returns pause/resume so
// hold-to-talk can temporarily own the mic for an open-ended (LLM) ask, then hand it
// back. The controller is pure; this hook is just its React lifecycle + store wiring.
function useHandsFree(onUnknown: (text: string) => void): { pauseForPushToTalk: () => void; resumeAfterPushToTalk: () => void } {
  const handsFreeOn = useStore((s) => s.handsFreeOn);
  const ctrlRef = useRef<HandsFree | null>(null);
  const pausedRef = useRef(false);
  // The controller is built once; keep the latest onUnknown closure in a ref so the
  // caption it flashes always uses the current component state.
  const onUnknownRef = useRef(onUnknown);
  onUnknownRef.current = onUnknown;

  if (!ctrlRef.current) {
    ctrlRef.current = createHandsFree({
      getCtx: () => {
        const s = useStore.getState();
        return {
          mode: s.currentMode(),
          tempo: s.snapshot?.session?.tempo ?? 120,
          timeSigNum: s.snapshot?.session?.timeSigNumerator ?? 4,
          tracks: (s.snapshot?.tracks ?? []).map((t) => ({ id: t.id, name: t.name, mute: t.mute, solo: t.solo })),
        };
      },
      isBusy: () => useStore.getState().agentBusy,
      setBusy: (b) => useStore.getState().setAgentBusy(b),
      dispatch: async (action, heard) => {
        const s = useStore.getState();
        if (action.kind === "commands" && !action.commands.every(isDirectSafeCall)) {
          s.pushAgentUtter("UHOH", "that needs the agent host");
          return;
        }
        await handleFast(action, {
          // FS-B2a (H2) — the matched transcript IS threaded now, so a hands-free turn's
          // marker carries what was actually said instead of the action's own caption.
          runBatch: async (label, cmds) => { s.setAgentChangeSet(await executeDirectSafeCapabilities(label, cmds, { utterance: heard, source: "voice" })); },
          enterRecord: s.enterRecord, stopRecord: s.stopRecord, keepTake: s.keepTake, navTake: s.navTake,
          utter: (intent, say) => { s.pushAgentUtter(intent, say); },
          // AGT-MEM (M3) — same "remember" flow as the composer below, no local
          // component state available here so a write failure just utters UHOH
          // (matches this hook's existing error-feedback level for other actions).
          remember: async (rtext, scope) => {
            const res = await writePreference(s.exec, rtext, scope, true);
            if (res.ok) s.setMemoryToast({ text: rtext, scope, kind: "preference", ts: res.ts });
            else s.pushAgentUtter("UHOH", "couldn't remember that");
          },
        });
      },
      makeSource: (cb) => createContinuousVoiceInput(cb),
      setListening: (b) => useStore.getState().setAgentListening(b),
      onUnknown: (text) => onUnknownRef.current(text),
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
  const cockpit = useOwnerCockpit();
  const ownerCockpitEnabled = useSettings((state) => state.get("ownerCockpit") === true);
  const legacyBrainRef = useRef<ReturnType<typeof createBrain> | null>(null);
  if (!legacyBrainRef.current)
    legacyBrainRef.current = createBrain(() => useStore.getState().snapshot);

  // A brief, self-clearing caption. Used for the hands-free "heard but not a command"
  // acknowledgement so an always-on mic isn't a silent black box.
  const sayTimer = useRef<number | undefined>(undefined);
  const flashSay = (text: string) => {
    setSay(text);
    if (sayTimer.current !== undefined) clearTimeout(sayTimer.current);
    sayTimer.current = window.setTimeout(() => setSay((cur) => (cur === text ? null : cur)), 3200);
  };
  useEffect(() => () => { if (sayTimer.current !== undefined) clearTimeout(sayTimer.current); }, []);

  const voiceSupported = isVoiceSupported();
  // undefined = not yet built; null = platform has no speech API.
  const voiceRef = useRef<VoiceInput | null | undefined>(undefined);
  const realtimeRef = useRef<PushToTalkController | null>(null);
  const realtimeConnectingRef = useRef<Promise<PushToTalkController> | null>(null);
  const realtimeFailedRef = useRef(false);
  const pointerHeldRef = useRef(false);
  const handsFree = useHandsFree((heard) => flashSay(`“${heard}” (not a command)`));

  // The single funnel: typed text and final speech both arrive here.
  const run = async (text: string, allowSupervisor = true) => {
    if (!text || useStore.getState().agentBusy) return;
    setInput(""); setSay(null); setAgentBusy(true);
    try {
      const st = useStore.getState();
      if (ownerCockpitEnabled && classifyReportTrigger(text)) {
        const report = await ownerCockpitRuntime.createFromText(text);
        if (report) {
          const summary = `${report.kind} saved for approval`;
          playMoshiEarcon("report");
          setSay(summary);
          pushAgentUtter(report.kind === "blocker" ? "UHOH" : "ACK_GOT_IT", summary);
          return;
        }
      }

      // Deterministic fast path: an unambiguous, state-valid phrase runs locally (no API).
      // Anything ambiguous returns null and falls through to the LLM brain.
      const fast = matchFastPath(text, {
        mode: st.currentMode(),
        tempo: st.snapshot?.session?.tempo ?? 120,
        timeSigNum: st.snapshot?.session?.timeSigNumerator ?? 4,
        tracks: (st.snapshot?.tracks ?? []).map((t) => ({ id: t.id, name: t.name, mute: t.mute, solo: t.solo })),
      });
      if (fast && (fast.kind !== "commands" || fast.commands.every(isDirectSafeCall))) {
        await handleFast(fast, {
          runBatch: async (label, cmds) => { setAgentChangeSet(await executeDirectSafeCapabilities(label, cmds, { utterance: text, source: "fastpath" })); },
          enterRecord: st.enterRecord, stopRecord: st.stopRecord, keepTake: st.keepTake, navTake: st.navTake,
          utter: (intent, say) => { setSay(say ?? null); pushAgentUtter(intent, say); },
          // AGT-MEM (M3) — writes explicit:true (a user, not the model, asked for
          // this) and surfaces the confirm toast (MemoryToast, v2) with its
          // delete-by-ts Undo affordance — memory writes are non-undoable by design.
          remember: async (rtext, scope) => {
            const res = await writePreference(st.exec, rtext, scope, true);
            if (res.ok) st.setMemoryToast({ text: rtext, scope, kind: "preference", ts: res.ts });
            else setSay(`couldn't remember that — ${res.error}`);
          },
        });
        return;
      }

      if (!ownerCockpitEnabled && loopAllowed() && routeAsk(text) === "loop") {
        await runLoopTask(text, {
          say: (message) => setSay(message),
          utter: (intent, message) => pushAgentUtter(intent, message),
        });
        return;
      }

      if (!allowSupervisor) {
        setSay("Realtime unavailable — type complex requests.");
        pushAgentUtter("UHOH", "Realtime unavailable — type complex requests.");
        return;
      }

      if (!ownerCockpitEnabled) {
        const legacyBrain = legacyBrainRef.current;
        if (!legacyBrain) throw new Error("brain unavailable");
        const reply = await legacyBrain.send(text);
        const commands = reply.commands ?? [];
        setSay(reply.say ?? null);
        pushAgentUtter(reply.intent ?? "UHOH", reply.say);
        if (commands.length > 0)
          setAgentChangeSet(await runAgentBatch(reply.say || text, commands, {
            utterance: text,
            source: "brain_chat",
          }));
        else
          await logAgentTurn(reply.say || text, { utterance: text, source: "brain_chat" });
        return;
      }

      if (cockpit.status !== "active") {
        const startRequired = "Start the owner playtest before using the hosted supervisor.";
        setSay(startRequired);
        pushAgentUtter("UHOH", startRequired);
        return;
      }

      const snapshot = st.snapshot;
      const supervised = await requestCapabilitySupervisor(text, {
        playing: snapshot?.transport.playing,
        recording: snapshot?.transport.recording,
        metronomeEnabled: snapshot?.session.metronome,
        tempo: snapshot?.session.tempo,
        timelinePosition: snapshot?.transport.position,
        loopStart: snapshot?.transport.loopStart,
        loopEnd: snapshot?.transport.loopEnd,
        timeSignature: snapshot ? `${snapshot.session.timeSigNumerator}/${snapshot.session.timeSigDenominator}` : undefined,
      });
      setSay(supervised.plan.say || null);
      pushAgentUtter(supervised.plan.intent || "ACK_GOT_IT", supervised.plan.say);
      if (supervised.calls.length > 0) {
        const cs = await runAgentBatch(supervised.plan.say || text, supervised.calls, { utterance: text, source: "supervisor" });
        setAgentChangeSet(cs);
        emitCapabilityTelemetry(recordCapabilityToolResult(supervised.telemetry, cs.entries.every((entry) => entry.ok), 0, supervised.telemetry.latencyMs));
      } else {
        // FS-B2a (H3) — the brain answered but planned nothing. Without this the ask
        // leaves no trace, and "what people asked for that we couldn't do" is exactly
        // what real-session skill mining needs most.
        await logAgentTurn(supervised.plan.say || text, { utterance: text, source: "supervisor" });
        emitCapabilityTelemetry(recordCapabilityToolResult(supervised.telemetry, true, 0, supervised.telemetry.latencyMs));
      }
    } catch (error) {
      if (error instanceof AgentHostUnavailableError) {
        setSay("brain unavailable");
        pushAgentUtter("UHOH", "brain unavailable");
      } else {
        setSay("hmm — that broke");
        pushAgentUtter("UHOH");
      }
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
        onFinal: (t) => {
          if (!realtimeFailedRef.current) {
            void run(t);
            return;
          }
          const state = useStore.getState();
          const fallback = realtimeFallbackFor(t, {
            mode: state.currentMode(),
            tempo: state.snapshot?.session?.tempo ?? 120,
            timeSigNum: state.snapshot?.session?.timeSigNumerator ?? 4,
            tracks: (state.snapshot?.tracks ?? []).map((track) => ({
              id: track.id,
              name: track.name,
              mute: track.mute,
              solo: track.solo,
            })),
          });
          if (fallback.allowed) void run(t, false);
          else {
            setSay("Realtime unavailable — type complex requests.");
            pushAgentUtter("UHOH", "Realtime unavailable — type complex requests.");
          }
        },
        onError: () => { setListening(false); setAgentListening(false); handsFree.resumeAfterPushToTalk(); setSay("didn't catch that"); },
      });
    }
    return voiceRef.current;
  };

  const ensureRealtime = (): Promise<PushToTalkController> => {
    if (realtimeRef.current) return Promise.resolve(realtimeRef.current);
    if (realtimeConnectingRef.current) return realtimeConnectingRef.current;
    const controller = createOpenAIRealtimeController({
      getClientSecret: () => ownerCockpitRuntime.client.realtimeSecret(),
      isRecording: () => useStore.getState().transport.recording,
      onFailure: () => {
        realtimeFailedRef.current = true;
        realtimeRef.current = null;
        realtimeConnectingRef.current = null;
        setListening(false);
        setAgentListening(false);
        setSay("Realtime unavailable — safe voice commands only.");
        playMoshiEarcon("error");
      },
      runDirectSafe: async (command, args) => {
        const call = { command, args };
        if (!isDirectSafeCall(call)) return "That command needs the supervisor.";
        const changeSet = await executeDirectSafeCapabilities("Realtime command", [call], { source: "realtime" });
        setAgentChangeSet(changeSet);
        return changeSet.entries.every((entry) => entry.ok) ? "Done." : "That did not apply.";
      },
      draftReport: async (report) => {
        const durable = await ownerCockpitRuntime.createReport(report);
        return `${durable.kind} saved for approval.`;
      },
      delegateSupervisor: async (message) => {
        const snapshot = useStore.getState().snapshot;
        const supervised = await requestCapabilitySupervisor(message, {
          playing: snapshot?.transport.playing,
          recording: snapshot?.transport.recording,
          timelinePosition: snapshot?.transport.position,
        });
        if (supervised.calls.length > 0) {
          const changeSet = await runAgentBatch(supervised.plan.say || message, supervised.calls, {
            utterance: message,
            source: "realtime-supervisor",
          });
          setAgentChangeSet(changeSet);
        }
        return supervised.plan.say || "Done.";
      },
    });
    realtimeConnectingRef.current = controller.connect().then(() => {
      if (ownerCockpitRuntime.getSnapshot().status !== "active") {
        void controller.dispose();
        throw new Error("playtest closed");
      }
      realtimeRef.current = controller;
      realtimeFailedRef.current = false;
      playMoshiEarcon("ready");
      return controller;
    }).catch((error) => {
      realtimeFailedRef.current = true;
      realtimeConnectingRef.current = null;
      void controller.dispose();
      throw error;
    });
    return realtimeConnectingRef.current;
  };

  const playing = useStore((state) => state.transport.playing);
  useEffect(() => realtimeRef.current?.setPlaybackActive(playing), [playing]);
  useEffect(() => {
    if (cockpit.status === "active") return;
    void realtimeRef.current?.dispose();
    realtimeRef.current = null;
    realtimeConnectingRef.current = null;
  }, [cockpit.status]);
  const recording = useStore((state) => state.transport.recording);
  useEffect(() => {
    if (recording) void realtimeRef.current?.cancel();
  }, [recording]);
  useEffect(() => () => {
    pointerHeldRef.current = false;
    void realtimeRef.current?.dispose();
    realtimeRef.current = null;
  }, []);

  const voiceAvailable = (ownerCockpitEnabled && cockpit.status === "active") || voiceSupported;
  const micLabel = !voiceAvailable ? "Voice unavailable here — type instead"
    : listening ? "Listening… release to send" : "Hold to talk";

  return (
    <div className="agent-composer">
      {say && <div className="agent-say" role="status" aria-live="polite">{say}</div>}
      <div className={`agent-input${listening ? " listening" : ""}`}>
        <button
          className={`agent-mic${listening ? " on" : ""}`}
          title={micLabel} aria-label={micLabel} aria-pressed={listening}
          disabled={!voiceAvailable || agentBusy}
          data-testid="agent-mic"
          onPointerDown={(e) => {
            if (agentBusy || !voiceAvailable) return;
            pointerHeldRef.current = true;
            if (useStore.getState().transport.recording
              && ownerCockpitEnabled
              && cockpit.status === "active") {
              pointerHeldRef.current = false;
              setSay("Stop recording before talking to Moshi.");
              playMoshiEarcon("error");
              pushAgentUtter("UHOH", "Stop recording before talking to Moshi.");
              return;
            }
            handsFree.pauseForPushToTalk();
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
            if (ownerCockpitEnabled && cockpit.status === "active" && !realtimeFailedRef.current) {
              setListening(true);
              setAgentListening(true);
              void ensureRealtime().then(async (controller) => {
                if (!pointerHeldRef.current) return controller.release();
                await controller.press({ recording: useStore.getState().transport.recording });
              }).catch(() => {
                setListening(false);
                setAgentListening(false);
                setSay("Realtime unavailable — safe voice commands only.");
                ensureVoice()?.start();
              });
              return;
            }
            ensureVoice()?.start();
          }}
          onPointerUp={() => {
            pointerHeldRef.current = false;
            void realtimeRef.current?.release();
            voiceRef.current?.stop();
            setListening(false);
            setAgentListening(false);
            handsFree.resumeAfterPushToTalk();
          }}
          onPointerCancel={() => {
            pointerHeldRef.current = false;
            void realtimeRef.current?.cancel();
            voiceRef.current?.stop();
            setListening(false);
            setAgentListening(false);
            handsFree.resumeAfterPushToTalk();
          }}
        >
          {listening
            ? <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: "50%", background: "currentColor" }} />
            : <IconMic size={16} />}
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
          <IconArrowUp size={13} />
        </button>
      </div>
    </div>
  );
}
