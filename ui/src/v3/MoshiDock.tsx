import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { runAgentBatch, logAgentTurn, undoAgentBatch } from "../agent/executor";
import { matchFastPath } from "../agent/fastPath";
import { handleFast } from "../agent/performer";
import { writePreference } from "../agent/memory/writePreference";
import { resolveSectionRework, planSectionRework } from "../agent/sectionScope";
import { createDockVoice, type DockVoice } from "./dockVoice";
import { runStudioSkillV1, clearDefaultStudioSkillContinuationsV1 } from "../agent/skillFoundry/runtime";
import type { SkillChoiceV1, SkillOutcomeV1, StudioSkillEnvironmentV1 } from "../agent/skillFoundry/contracts";
import { readSkillSourceStatusV1 } from "../agent/skillFoundry/nativeReads";
import { createRecordingLifecycleEnvironmentV1 } from "../recordingLifecycle";
import { loopAllowed, runLoopTask } from "../agent/loop/runTask";
import { routeAsk } from "../agent/loop/router";
import { matchIssueReport } from "../agent/issueRoute";
import { activeShell } from "../v2/shellFlag";
import { brainRuntimeStatus, nativeMenuPresent, onEvent, type BrainRuntimeStatus } from "../bridge";
import { IconArrowUp, IconMic } from "../ui/icons";
import { MoshiFace } from "./MoshiFace";
import { useProducerRack } from "../agent/loop/producerRack";
import { useTaskStore } from "../agent/loop/taskStore";
import { formatElapsed, taskProgress } from "./agentTask";

export function recordingDisablesDock(recording: boolean): boolean {
  return recording;
}

// A greeting or a "what can you do" gets a local, deterministic reply (no model, no skill, no
// engine command) that points at asks the dock handles instantly. Full-string anchored, so
// "hey moshi, make the drums louder" still goes to the normal path.
const GREETING = /^(?:hi|hey|hello|yo|hiya)(?:[,\s]+moshi)?[\s!.?]*$/i;
const HELP = /^(?:help|what can you do\??|what do you do\??)$/i;
export const DOCK_HELLO = "hey! try 'set the tempo to 90' or 'turn the drums down 3 dB'";
export function dockGreetingReply(text: string): string | null {
  const t = text.trim();
  return GREETING.test(t) || HELP.test(t) ? DOCK_HELLO : null;
}

export function MoshiDock() {
  const agentBusy = useStore((s) => s.agentBusy);
  const setAgentBusy = useStore((s) => s.setAgentBusy);
  const setAgentChangeSet = useStore((s) => s.setAgentChangeSet);
  const pushAgentUtter = useStore((s) => s.pushAgentUtter);
  const recording = useStore((s) => s.transport.recording);
  const celebrateTick = useStore((s) => s.celebrateTick);
  const changeSet = useStore((s) => s.agentChangeSet);
  const safe = recordingDisablesDock(recording);
  const [input, setInput] = useState("");
  const [say, setSay] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [choices, setChoices] = useState<readonly SkillChoiceV1[]>([]);
  const [brainRuntime, setBrainRuntime] = useState<BrainRuntimeStatus | null>(null);
  const runRef = useRef<(text: string, source: "typed" | "push_to_talk") => void>(() => {});
  const pendingSkillToken = useRef<string | null>(null);
  const voiceRef = useRef<DockVoice | null>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  const pttRef = useRef(false);
  // A7 — the live agent task (read-only). Stop flips the task's abort signal; the loop honours
  // it between steps, so "Stopping…" stays up until the task actually ends (current === null).
  // Keyed on the signal object so the next task always starts un-stopped.
  const task = useTaskStore((s) => s.current);
  const taskSignal = useTaskStore((s) => s.signal);
  const [stoppedSignal, setStoppedSignal] = useState<{ aborted: boolean } | null>(null);
  const stopping = task !== null && taskSignal !== null && stoppedSignal === taskSignal;
  const [, setTick] = useState(0);
  const taskLive = task !== null;
  useEffect(() => {
    if (!taskLive) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [taskLive]);
  const stopTask = () => {
    const tasks = useTaskStore.getState();
    tasks.requestStop();
    setStoppedSignal(tasks.signal);
  };

  useEffect(() => {
    void brainRuntimeStatus().then(setBrainRuntime).catch(() => setBrainRuntime({ state: "unavailable" }));
    return onEvent("brain_runtime", (payload) => setBrainRuntime(payload as BrainRuntimeStatus));
  }, []);

  // D2 — the reply caption that came with a receipt (the fast path's "90 bpm") is part of it.
  // When a later edit retires the receipt (store.exec), the caption goes too, or it would stand
  // in for the receipt as a stale reply. Subscribed rather than an effect, so it runs at the
  // moment of retirement: a new ask clears the receipt BEFORE it sets its own reply, never after.
  useEffect(() => useStore.subscribe((state, prev) => {
    if (prev.agentChangeSet && !state.agentChangeSet) setSay(null);
  }), []);

  const projectEpoch = useStore((s) => s.projectEpoch);
  useEffect(() => {
    pendingSkillToken.current = null;
    setChoices([]);
    void clearDefaultStudioSkillContinuationsV1();
  }, [projectEpoch]);

  useEffect(() => {
    if (safe) {
      setChoices([]);
      setSay(null);
      voiceRef.current?.stop();
      setListening(false);
    }
  }, [safe]);

  const buildSkillEnvironment = (text: string): StudioSkillEnvironmentV1 => ({
    context: () => {
      const current = useStore.getState();
      return {
        projectEpoch: current.projectEpoch,
        selectedTrackId: current.selectedTrackId,
        tracks: (current.snapshot?.tracks ?? []).map((track) => ({ id: track.id, name: track.name })),
      };
    },
    snapshot: async () => {
      const snap = useStore.getState().snapshot;
      if (!snap) throw new Error("no session snapshot available");
      return snap;
    },
    exec: (command, args, transaction) => useStore.getState().exec(command, args, transaction),
    readSourceStatus: readSkillSourceStatusV1,
    runBatch: (label, calls) => runAgentBatch(label, calls, { utterance: text, source: "studio_skill" }),
    refresh: () => useStore.getState().refresh(),
    recording: createRecordingLifecycleEnvironmentV1({
      enterRecord: (bar) => useStore.getState().enterRecord(bar),
      stopRecord: () => useStore.getState().stopRecord(),
      navTake: (delta) => useStore.getState().navTake(delta),
      keepTake: () => useStore.getState().keepTake(),
    }),
  });

  const finishSkillOutcome = async (skill: SkillOutcomeV1, text: string): Promise<boolean> => {
    if (skill.kind === "completed") {
      setAgentChangeSet(skill.changes);
      setSay(skill.say);
      setChoices([]);
      pushAgentUtter("DONE", skill.say);
      return true;
    }
    if (skill.kind === "needs_choice") {
      pendingSkillToken.current = skill.continuationToken;
      setSay(skill.say);
      setChoices(skill.options);
      pushAgentUtter("HUH", skill.say);
      return true;
    }
    if (skill.kind === "blocked") {
      if (skill.unserved) await logAgentTurn(skill.say, { utterance: text, source: "studio_skill_blocked" });
      setSay(skill.say);
      setChoices([]);
      pushAgentUtter("UHOH", skill.say);
      return true;
    }
    return false;
  };

  const run = async (text: string, source: "typed" | "push_to_talk" = "typed") => {
    if (!text || useStore.getState().agentBusy || recordingDisablesDock(useStore.getState().transport.recording)) return;
    const runStartedAt = Date.now();
    // A new ask retires the previous receipt: a stale change set would hide this ask's reply.
    setInput(""); setSay(null); setAgentChangeSet(null); setChoices([]); setAgentBusy(true);
    try {
      const st = useStore.getState();
      if (useProducerRack.getState().rack) {
        if (!loopAllowed()) throw new Error("The Producer loop is unavailable in this session");
        await runLoopTask(text, { say: setSay, utter: pushAgentUtter });
        return;
      }
      const hello = dockGreetingReply(text);
      if (hello) {
        pendingSkillToken.current = null;   // a new turn abandons any hidden clarification
        setSay(hello); pushAgentUtter("DONE", hello);
        return;
      }
      const issue = matchIssueReport(text);
      if (issue) {
        const result = await st.exec("report_issue", {
          ...issue, source, activeShell: activeShell(), selectedTrackId: st.selectedTrackId,
          selectedClipIds: Array.from(st.selection), runtimeModelIdentity: brainRuntime?.model ?? null,
        }) as { ok: boolean; data?: { issueId?: string }; error?: string };
        if (!result.ok) throw new Error(result.error ?? "issue report failed");
        const reply = `logged ${result.data?.issueId ?? "that issue"} locally`;
        setSay(reply); pushAgentUtter("DONE", reply);
        return;
      }

      const token = pendingSkillToken.current;
      pendingSkillToken.current = null;
      if (token) {
        const skill = await runStudioSkillV1(text, buildSkillEnvironment(text), token);
        if (!(await finishSkillOutcome(skill, text))) {
          await logAgentTurn(skill.say, { utterance: text, source: "studio_skill_unsupported" });
          setSay(skill.say);
          pushAgentUtter("HUH", skill.say);
        }
        return;
      }

      const rework = resolveSectionRework(text, st.snapshot);
      if (rework) {
        if (rework.kind === "empty") {
          await logAgentTurn(rework.reason, { utterance: text, source: "section_scope" });
          setSay(rework.reason); pushAgentUtter("HUH", rework.reason);
          return;
        }
        const label = `rework the ${rework.section.name}`;
        setAgentChangeSet(await runAgentBatch(label, planSectionRework(rework), { utterance: text, source: "section_scope" }));
        setSay(`reworking the ${rework.section.name}`); pushAgentUtter("ACK_WORKING", `reworking the ${rework.section.name}`);
        return;
      }

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
          utter: (intent, caption) => { setSay(caption ?? null); pushAgentUtter(intent, caption); },
          remember: async (rtext, scope) => {
            const res = await writePreference(st.exec, rtext, scope, true);
            if (res.ok) st.setMemoryToast({ text: rtext, scope, kind: "preference", ts: res.ts });
            else setSay(`couldn't remember that — ${res.error}`);
          },
        });
        return;
      }

      const skill = await runStudioSkillV1(text, buildSkillEnvironment(text));
      if (await finishSkillOutcome(skill, text)) return;

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
      // A loop task that threw before finish() would leave the view (and every button gated on
      // a live task) stuck on "Working". Its transaction already closed (runTask's finally), so
      // end the view of the task THIS ask started.
      const tasks = useTaskStore.getState();
      if (tasks.current && tasks.current.startedAt >= runStartedAt) tasks.finish({ outcome: "error" });
      setSay("hmm — that broke");
      pushAgentUtter("UHOH");
    } finally {
      setAgentBusy(false);
    }
  };
  runRef.current = (text, source) => { void run(text, source); };

  const ensureVoice = (): DockVoice => {
    if (!voiceRef.current) {
      voiceRef.current = createDockVoice({
        onStart: () => { setListening(true); setInput(""); },
        onInterim: (t) => setInput(t),
        onStop: () => { setListening(false); },
        onFinal: (t) => void run(t, "push_to_talk"),
        onError: () => { setListening(false); setSay("didn't catch that"); },
      });
    }
    return voiceRef.current;
  };

  const startVoice = () => {
    if (safe || agentBusy) return;
    if (useStore.getState().currentMode() === "recording") return;
    void ensureVoice().start();
  };

  const disabled = safe || agentBusy;
  // The packaged app strips the speech-recognition usage string, so dictation can never work
  // there; the mic is a dev-lane (Vite) affordance only.
  const showMic = !nativeMenuPresent();
  const clarify = choices.length > 0 && !safe;
  const receipt = !safe && changeSet && changeSet.entries.length > 0 ? changeSet : null;

  return (
    <div className={`prompt${safe ? " safe" : ""}`} data-testid="v3-moshi-dock" data-recording-safe={safe || undefined}>
      {task && (
        <div className="receipt task" data-testid="v3-moshi-task" role="status">
          <span>
            {stopping ? "Stopping after this step… · " : `Working · ${taskProgress(task)} · `}
            <span aria-hidden="true">{formatElapsed(Date.now() - task.startedAt)}</span>
          </span>
          <button type="button" className="btn sm" data-testid="v3-moshi-stop" disabled={stopping} onClick={stopTask}>
            Stop
          </button>
        </div>
      )}
      {receipt && (
        <div className="receipt" data-testid="v3-receipt" role="status">
          <span>{receipt.entries[0]?.summary ?? receipt.label}</span>
          <button type="button" className="btn sm" onClick={() => void undoAgentBatch().then(() => setAgentChangeSet(null))}>
            Undo
          </button>
        </div>
      )}
      {!safe && say && !receipt && <div className="receipt" role="status">{say}</div>}
      {clarify && (
        <div className="clarify" data-testid="v3-clarify">
          {choices.map((c) => (
            <button key={c.id} type="button" className="cchip" onClick={() => void run(c.label)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="adock">
        <button type="button" className={`moshi-btn${listening ? " listen" : ""}${agentBusy ? " busy" : ""}`}
          disabled={disabled} aria-label="Moshi" data-testid="v3-moshi-ring">
          <span className={`ring${clarify ? " clarify" : ""}`} />
          <MoshiFace celebrateTick={celebrateTick} mood={{ safe, busy: agentBusy, listening, clarify }} />
        </button>
        <input
          className={`field${clarify ? " clarify" : ""}`}
          data-testid="v3-moshi-field"
          data-owns-edit-keys=""
          value={input}
          placeholder={safe ? "recording…" : listening ? "listening…" : agentBusy ? "thinking…" : "Ask Moshi"}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) void run(input.trim()); }}
        />
        {showMic && <button
          type="button"
          className={`ibtn${listening ? " on" : ""}`}
          data-testid="v3-moshi-mic"
          disabled={disabled}
          aria-label={listening ? "Listening" : "Dictate or hold to talk"}
          onPointerDown={(e) => {
            if (disabled) return;
            holdTimer.current = window.setTimeout(() => {
              pttRef.current = true;
              startVoice();
            }, 220);
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* tap still works */ }
          }}
          onPointerUp={() => {
            if (holdTimer.current !== undefined) window.clearTimeout(holdTimer.current);
            if (pttRef.current) {
              voiceRef.current?.stop();
              pttRef.current = false;
            } else if (!listening) {
              startVoice();
            }
          }}
          onPointerCancel={() => {
            if (holdTimer.current !== undefined) window.clearTimeout(holdTimer.current);
            voiceRef.current?.stop();
            pttRef.current = false;
          }}
        >
          <IconMic size={16} />
        </button>}
        <button type="button" className="btn pri sm" data-testid="v3-moshi-send"
          disabled={disabled || !input.trim()} onClick={() => void run(input.trim())} aria-label="Send">
          <IconArrowUp size={13} />
        </button>
      </div>
    </div>
  );
}
