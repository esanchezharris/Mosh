// The composer that lives in Moshi's rail. You ask — by holding the mic to TALK
// (voice-hero) or by typing (the quiet fallback) — a bounded studio skill resolves
// the request, the executor runs its edits as ONE undo step, and the result lands
// in Monster changes. Voice and text feed the same run() funnel.

import { useRef, useState, useEffect } from "react";
import { useStore } from "../store";
import { runAgentBatch, logAgentTurn } from "../agent/executor";
import { matchFastPath } from "../agent/fastPath";
import { handleFast } from "../agent/performer";
import { writePreference } from "../agent/memory/writePreference";
import { resolveSectionRework, planSectionRework } from "../agent/sectionScope";
import { createVoiceInput, createContinuousVoiceInput, isVoiceSupported, type VoiceInput } from "../agent/voiceInput";
import { createHandsFree, type HandsFree } from "../agent/handsFree";
import { loopAllowed, runLoopTask } from "../agent/loop/runTask";
import { routeAsk } from "../agent/loop/router";
import { runStudioSkill, type StudioSkillContinuation } from "../agent/studioSkills";
import { IconArrowUp, IconMic } from "./icons";

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
        await handleFast(action, {
          // FS-B2a (H2) — the matched transcript IS threaded now, so a hands-free turn's
          // marker carries what was actually said instead of the action's own caption.
          runBatch: async (label, cmds) => { s.setAgentChangeSet(await runAgentBatch(label, cmds, { utterance: heard, source: "voice" })); },
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
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
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
  const pendingSkill = useRef<StudioSkillContinuation | null>(null);

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
  const handsFree = useHandsFree((heard) => flashSay(`“${heard}” (not a command)`));

  // The single funnel: typed text and final speech both arrive here.
  const run = async (text: string) => {
    if (!text || useStore.getState().agentBusy) return;
    setInput(""); setSay(null); setAgentBusy(true);
    try {
      const st = useStore.getState();
      const continuation = pendingSkill.current;
      pendingSkill.current = null;

      // Section scope FIRST: "rework the hook" → a render bounded to that section's beat
      // range. Deterministic (no LLM arithmetic). It runs BEFORE the fast path because a
      // named-section rework like "redo the hook" would otherwise be stolen by the fast
      // path's global "redo" (undo-history) rule. It claims a turn ONLY when the utterance
      // is a rework verb that names an existing section, so bare "redo"/"undo" still fall
      // through to the fast path untouched.
      const rework = resolveSectionRework(text, st.snapshot);
      if (rework) {
        if (rework.kind === "empty") {
          // FS-B2a (H3) — an ask we could not serve is a missing-skill signal; record it.
          await logAgentTurn(rework.reason, { utterance: text, source: "section_scope" });
          setSay(rework.reason); pushAgentUtter("HUH", rework.reason);
          return;
        }
        const label = `rework the ${rework.section.name}`;
        setAgentChangeSet(await runAgentBatch(label, planSectionRework(rework), { utterance: text, source: "section_scope" }));
        setSay(`reworking the ${rework.section.name}`); pushAgentUtter("ACK_WORKING", `reworking the ${rework.section.name}`);
        return;
      }

      // Deterministic fast path: an unambiguous, state-valid phrase runs locally (no API).
      // Anything ambiguous returns null and falls through to the studio-skill runner.
      const fast = matchFastPath(text, {
        mode: st.currentMode(),
        tempo: st.snapshot?.session?.tempo ?? 120,
        timeSigNum: st.snapshot?.session?.timeSigNumerator ?? 4,
        tracks: (st.snapshot?.tracks ?? []).map((t) => ({ id: t.id, name: t.name, mute: t.mute, solo: t.solo })),
      });
      if (fast) {
        await handleFast(fast, {
          runBatch: async (label, cmds) => { setAgentChangeSet(await runAgentBatch(label, cmds, { utterance: text, source: "fastpath" })); },
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

      const skill = await runStudioSkill(text, {
        context: () => {
          const current = useStore.getState();
          return {
            projectEpoch: current.projectEpoch,
            selectedTrackId: current.selectedTrackId,
            tracks: (current.snapshot?.tracks ?? []).map((track) => ({ id: track.id, name: track.name })),
          };
        },
        exec: (command, args) => useStore.getState().exec(command, args),
        runBatch: (label, calls) => runAgentBatch(label, calls, { utterance: text, source: "studio_skill" }),
      }, continuation ?? undefined);
      if (skill.kind === "completed") {
        setAgentChangeSet(skill.changes);
        setSay(skill.say);
        pushAgentUtter("DONE", skill.say);
        return;
      }
      if (skill.kind === "needs_choice") {
        pendingSkill.current = skill.continuation ?? null;
        setSay(skill.say);
        pushAgentUtter("HUH", skill.say);
        return;
      }
      if (skill.kind === "blocked") {
        if (skill.unserved) {
          await logAgentTurn(skill.say, { utterance: text, source: "studio_skill_blocked" });
        }
        setSay(skill.say);
        pushAgentUtter("UHOH", skill.say);
        return;
      }

      // The old free-form loop is developer-build-only and never a packaged fallback.
      // The ROUTER sends multi-step-shaped asks — sequential clauses, creative
      // builds, vague-taste work — into the loop (plan, act, observe, repair,
      // ONE undo unit, live in the v2 drawer); short single-move asks stay on
      // the fail-closed skill path. Section-scope and the fast path keep
      // their precedence above; hands-free still never reaches an LLM.
      if (loopAllowed() && routeAsk(text) === "loop") {
        await runLoopTask(text, {
          say: (t) => setSay(t),
          utter: (intent, s) => pushAgentUtter(intent, s),
        });
        return;
      }

      await logAgentTurn(skill.say, { utterance: text, source: "studio_skill_unsupported" });
      setSay(skill.say);
      pushAgentUtter("HUH", skill.say);
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
            try { e.currentTarget.setPointerCapture(e.pointerId); }
            catch { v.start(); return; }
            v.start();
          }}
          onPointerUp={() => voiceRef.current?.stop()}
          onPointerCancel={() => voiceRef.current?.stop()}
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
