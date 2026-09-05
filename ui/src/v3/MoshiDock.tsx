import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { runAgentBatch, logAgentTurn, undoAgentBatch } from "../agent/executor";
import { matchFastPath } from "../agent/fastPath";
import { handleFast } from "../agent/performer";
import { writePreference } from "../agent/memory/writePreference";
import { resolveSectionRework, planSectionRework } from "../agent/sectionScope";
import { createVoiceInput, isVoiceSupported, type VoiceInput } from "../agent/voiceInput";
import { runStudioSkillV1, clearDefaultStudioSkillContinuationsV1 } from "../agent/skillFoundry/runtime";
import type { SkillChoiceV1, SkillOutcomeV1, StudioSkillEnvironmentV1 } from "../agent/skillFoundry/contracts";
import { readSkillSourceStatusV1 } from "../agent/skillFoundry/nativeReads";
import { createRecordingLifecycleEnvironmentV1 } from "../recordingLifecycle";
import { loopAllowed, runLoopTask } from "../agent/loop/runTask";
import { routeAsk } from "../agent/loop/router";
import { matchIssueReport } from "../agent/issueRoute";
import { activeShell } from "../v2/shellFlag";
import { brainRuntimeStatus, onEvent, type BrainRuntimeStatus } from "../bridge";
import { IconArrowUp, IconMic } from "../ui/icons";
import { MoshiFace } from "./MoshiFace";

export function recordingDisablesDock(recording: boolean): boolean {
  return recording;
}

export function MoshiDock() {
  const agentBusy = useStore((s) => s.agentBusy);
  const setAgentBusy = useStore((s) => s.setAgentBusy);
  const setAgentChangeSet = useStore((s) => s.setAgentChangeSet);
  const pushAgentUtter = useStore((s) => s.pushAgentUtter);
  const setAgentListening = useStore((s) => s.setAgentListening);
  const recording = useStore((s) => s.transport.recording);
  const celebrateTick = useStore((s) => s.celebrateTick);
  const changeSet = useStore((s) => s.agentChangeSet);
  const safe = recordingDisablesDock(recording);
  const [input, setInput] = useState("");
  const [say, setSay] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [choices, setChoices] = useState<readonly SkillChoiceV1[]>([]);
  const [brainRuntime, setBrainRuntime] = useState<BrainRuntimeStatus | null>(null);
  const runRef = useRef<(text: string, source: "typed" | "push_to_talk" | "always_on") => void>(() => {});
  const pendingSkillToken = useRef<string | null>(null);
  const voiceRef = useRef<VoiceInput | null | undefined>(undefined);
  const holdTimer = useRef<number | undefined>(undefined);
  const pttRef = useRef(false);
  const voiceSupported = isVoiceSupported();

  useEffect(() => {
    void brainRuntimeStatus().then(setBrainRuntime).catch(() => setBrainRuntime({ state: "unavailable" }));
    return onEvent("brain_runtime", (payload) => setBrainRuntime(payload as BrainRuntimeStatus));
  }, []);

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
      setAgentListening(false);
    }
  }, [safe, setAgentListening]);

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

  const run = async (text: string, source: "typed" | "push_to_talk" | "always_on" = "typed") => {
    if (!text || useStore.getState().agentBusy || recordingDisablesDock(useStore.getState().transport.recording)) return;
    setInput(""); setSay(null); setChoices([]); setAgentBusy(true);
    try {
      const st = useStore.getState();
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
      setSay("hmm — that broke");
      pushAgentUtter("UHOH");
    } finally {
      setAgentBusy(false);
    }
  };
  runRef.current = (text, source) => { void run(text, source); };

  const ensureVoice = (): VoiceInput | null => {
    if (voiceRef.current === undefined) {
      voiceRef.current = createVoiceInput({
        onStart: () => { setListening(true); setAgentListening(true); setInput(""); },
        onInterim: (t) => setInput(t),
        onStop: () => { setListening(false); setAgentListening(false); },
        onFinal: (t) => void run(t, "push_to_talk"),
        onError: () => { setListening(false); setAgentListening(false); setSay("didn't catch that"); },
      });
    }
    return voiceRef.current;
  };

  const startVoice = () => {
    if (safe || agentBusy || !voiceSupported) return;
    if (useStore.getState().currentMode() === "recording") return;
    const v = ensureVoice();
    v?.start();
  };

  const disabled = safe || agentBusy;
  const clarify = choices.length > 0 && !safe;
  const receipt = !safe && changeSet && changeSet.entries.length > 0 ? changeSet : null;

  return (
    <div className={`prompt${safe ? " safe" : ""}`} data-testid="v3-moshi-dock" data-recording-safe={safe || undefined}>
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
          <MoshiFace celebrateTick={celebrateTick} />
        </button>
        <input
          className={`field${clarify ? " clarify" : ""}`}
          data-testid="v3-moshi-field"
          value={input}
          placeholder={safe ? "recording…" : listening ? "listening…" : agentBusy ? "thinking…" : "Ask Moshi"}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) void run(input.trim()); }}
        />
        <button
          type="button"
          className={`ibtn${listening ? " on" : ""}`}
          data-testid="v3-moshi-mic"
          disabled={disabled || !voiceSupported}
          aria-label={listening ? "Listening" : "Dictate or hold to talk"}
          onPointerDown={(e) => {
            if (disabled || !voiceSupported) return;
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
        </button>
        <button type="button" className="btn pri sm" data-testid="v3-moshi-send"
          disabled={disabled || !input.trim()} onClick={() => void run(input.trim())} aria-label="Send">
          <IconArrowUp size={13} />
        </button>
      </div>
    </div>
  );
}
