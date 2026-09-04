import { useRef, useState, useEffect } from "react";
import { useStore } from "../store";
import { runAgentBatch, logAgentTurn } from "../agent/executor";
import { matchFastPath } from "../agent/fastPath";
import { handleFast } from "../agent/performer";
import { writePreference } from "../agent/memory/writePreference";
import { resolveSectionRework, planSectionRework } from "../agent/sectionScope";
import { loopAllowed, runLoopTask } from "../agent/loop/runTask";
import { routeAsk } from "../agent/loop/router";
// Skill Foundry Slice B, Task 7 — the composer's shared-runtime step now calls the ONE
// registry-backed runtime (Task 6) directly, replacing the legacy single-skill
// `studioSkills.ts` import it used to route through. `studioSkills.ts` itself is untouched
// (its own header note: Task 7 "retires it as a routing path", not deletes it) — every
// other precedence rule (section rework, fast path incl. remember/track-ops, dev loop,
// unsupported) is unchanged.
import { runStudioSkillV1, clearDefaultStudioSkillContinuationsV1 } from "../agent/skillFoundry/runtime";
import type { SkillOutcomeV1, StudioSkillEnvironmentV1 } from "../agent/skillFoundry/contracts";
import { readSkillSourceStatusV1 } from "../agent/skillFoundry/nativeReads";
import { createRecordingLifecycleEnvironmentV1 } from "../recordingLifecycle";
import { IconArrowUp } from "./icons";
import { brainRuntimeStatus, onEvent, type BrainRuntimeStatus } from "../bridge";
import { activeShell } from "../v2/shellFlag";
import { matchIssueReport } from "../agent/issueRoute";
import { IssueInbox } from "./IssueInbox";

export function AgentComposer() {
  const agentBusy = useStore((s) => s.agentBusy);
  const setAgentBusy = useStore((s) => s.setAgentBusy);
  const setAgentChangeSet = useStore((s) => s.setAgentChangeSet);
  const pushAgentUtter = useStore((s) => s.pushAgentUtter);
  const [input, setInput] = useState("");
  const [say, setSay] = useState<string | null>(null);
  const [brainRuntime, setBrainRuntime] = useState<BrainRuntimeStatus | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  useEffect(() => {
    void brainRuntimeStatus().then(setBrainRuntime).catch(() => setBrainRuntime({ state: "unavailable" }));
    return onEvent("brain_runtime", (payload) => setBrainRuntime(payload as BrainRuntimeStatus));
  }, []);
  // Skill Foundry Slice B, Task 7 — the composer stores ONLY the opaque continuation
  // token (a bare string); the runtime is the one thing that resolves it back to a
  // handler/payload. No typed continuation shape lives in React state any more.
  const pendingSkillToken = useRef<string | null>(null);


  // Skill Foundry Slice B, Task 7 — a project-epoch change (new/opened/reloaded project)
  // invalidates any pending continuation: clear the React token AND the runtime's own
  // (and each native handler's private) continuation store, so a stale choice answered
  // against the PREVIOUS project can never resolve against the new one.
  const projectEpoch = useStore((s) => s.projectEpoch);
  useEffect(() => {
    pendingSkillToken.current = null;
    void clearDefaultStudioSkillContinuationsV1();
  }, [projectEpoch]);

  // Skill Foundry Slice B, Task 7 — the ONE environment the registry-backed runtime
  // (all four native skills) is driven through. `context`/`exec`/`runBatch` mirror what
  // the retired `studioSkills.ts` routing path built; `snapshot`/`readSourceStatus`/
  // `refresh`/`recording` are new — required by `StudioSkillEnvironmentV1` (contracts.ts)
  // but never used by the pre-Task-7 composer, which only ever reached load-named-plugin.
  const buildSkillEnvironment = (text: string): StudioSkillEnvironmentV1 => ({
    context: () => {
      const current = useStore.getState();
      return {
        projectEpoch: current.projectEpoch,
        selectedTrackId: current.selectedTrackId,
        tracks: (current.snapshot?.tracks ?? []).map((track) => ({ id: track.id, name: track.name })),
      };
    },
    // A plain read of the store's already-fetched snapshot — NOT a forced re-fetch. A
    // handler that needs guaranteed-fresh state calls `refresh()` first (session-control's
    // `runSave` does exactly this), matching the one existing precedent for the contract.
    snapshot: async () => {
      const snap = useStore.getState().snapshot;
      if (!snap) throw new Error("no session snapshot available");
      return snap;
    },
    exec: (command, args, transaction) => useStore.getState().exec(command, args, transaction),
    readSourceStatus: readSkillSourceStatusV1,
    runBatch: (label, calls) => runAgentBatch(label, calls, { utterance: text, source: "studio_skill" }),
    refresh: () => useStore.getState().refresh(),
    // The Task 2 adapter (recordingLifecycle.ts) narrows the store's own richer
    // enterRecord/stopRecord/navTake/keepTake outcomes down to the generic
    // RecordingLifecycleEnvironmentV1 shape takeCycleV1/session-control's Stop consume.
    recording: createRecordingLifecycleEnvironmentV1({
      enterRecord: (bar) => useStore.getState().enterRecord(bar),
      stopRecord: () => useStore.getState().stopRecord(),
      navTake: (delta) => useStore.getState().navTake(delta),
      keepTake: () => useStore.getState().keepTake(),
    }),
  });

  // Skill Foundry Slice B, Task 7 — the three terminal outcomes are handled identically
  // whether the runtime call was a continuation resume or a fresh match; only
  // `unsupported` is NOT handled here (the fresh-match caller alone may fall through to
  // the gated dev loop for it — a resume never does, see the caller below).
  const finishSkillOutcome = async (skill: SkillOutcomeV1, text: string): Promise<boolean> => {
    if (skill.kind === "completed") {
      setAgentChangeSet(skill.changes);
      setSay(skill.say);
      pushAgentUtter("DONE", skill.say);
      return true;
    }
    if (skill.kind === "needs_choice") {
      // Task 7 — ONLY the opaque token string is retained; the runtime (plus each native
      // handler's own private continuation store) owns everything it resolves to.
      pendingSkillToken.current = skill.continuationToken;
      setSay(skill.say);
      pushAgentUtter("HUH", skill.say);
      return true;
    }
    if (skill.kind === "blocked") {
      if (skill.unserved) {
        await logAgentTurn(skill.say, { utterance: text, source: "studio_skill_blocked" });
      }
      setSay(skill.say);
      pushAgentUtter("UHOH", skill.say);
      return true;
    }
    return false;
  };

  const run = async (text: string, source: "typed" | "push_to_talk" | "always_on" = "typed") => {
    if (!text || useStore.getState().agentBusy) return;
    setInput(""); setSay(null); setAgentBusy(true);
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
        setSay(reply); pushAgentUtter("DONE", reply); setInboxOpen(true);
        return;
      }

      // Skill Foundry Slice B, Task 7 — a continuation ALWAYS resumes before any new
      // matcher gets a look at the utterance: not section rework, not the fast path
      // (remember/track-ops/RULES), not a fresh skill match. The token is read and
      // cleared BEFORE any await, so a stale/failed resume can never be replayed.
      const token = pendingSkillToken.current;
      pendingSkillToken.current = null;
      if (token) {
        const skill = await runStudioSkillV1(text, buildSkillEnvironment(text), token);
        if (!(await finishSkillOutcome(skill, text))) {
          // Defensive: an (unexpected) unsupported resume still gets user feedback —
          // never silently dropped, and never routed to the dev loop/brain.
          await logAgentTurn(skill.say, { utterance: text, source: "studio_skill_unsupported" });
          setSay(skill.say);
          pushAgentUtter("HUH", skill.say);
        }
        return;
      }

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
      // Owns explicit "remember" (never skill routing — its own non-MoshOps write) and
      // bulk/multi-name track ops (matchTrackOp) ABOVE skill routing, at their existing
      // precedence — unchanged by Task 7 (owner resolution: explicit-balance stays
      // single-target; matchTrackOp is not extended, removed, or relocated). Anything
      // ambiguous returns null and falls through to the studio-skill runtime.
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

      // Skill Foundry Slice B, Task 7 — the shared runtime: the ONE registry-backed path
      // for all four native skills (session-control, capture-review-choose-take,
      // explicit-balance, load-named-plugin).
      const skill = await runStudioSkillV1(text, buildSkillEnvironment(text));
      if (await finishSkillOutcome(skill, text)) return;

      // The old free-form loop is developer-build-only and never a packaged fallback.
      // The ROUTER sends multi-step-shaped asks — sequential clauses, creative
      // builds, vague-taste work — into the loop (plan, act, observe, repair,
      // ONE undo unit, live in the v2 drawer); short single-move asks stay on
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

  return (
    <div className="agent-composer">
      {inboxOpen && <IssueInbox onClose={() => setInboxOpen(false)} />}
      {brainRuntime && <div className={`agent-runtime ${brainRuntime.state}`} aria-live="polite"
        title={brainRuntime.error || brainRuntime.model || "Local brain"}>
        {brainRuntime.state}{brainRuntime.model ? ` · ${brainRuntime.model.split("/").pop()}` : ""}
      </div>}
      {say && <div className="agent-say" role="status" aria-live="polite">{say}</div>}
      <button className="issue-inbox-button" onClick={() => setInboxOpen((v) => !v)}>Issues</button>
      <div className="agent-input">
        <input
          data-testid="agent-input"
          value={input}
          placeholder={agentBusy ? "thinking…" : "Ask Moshi…"}
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
