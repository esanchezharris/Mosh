import { useEffect, useState } from "react";
import { aiToolsCancel, aiToolsInstall, aiToolsRemove, aiToolsStatus, onEvent, parseAiToolsInstallStatus } from "../bridge";
import type { AiToolsInstallStatus, AiToolsSnapshot, AiToolsStepId, AiToolsStepStatus } from "../types";

// "Add AI tools" in the V3 shell (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md §5.4): the setup
// card on the Start page, the Settings row and the dock's "That needs AI tools" reply all read
// one view. snapshot.aiTools says what is on disk; the installer status says what the
// installer is doing. Neither alone answers "what should this card offer".

export type AiToolsPhase =
  | "unavailable"   // this build can't add them (no bundled uv, or the web dev lane)
  | "off"           // nothing installed; Install is offered
  | "installing" | "cancelling" | "removing"
  | "failed"        // the last install stopped on an error; Try again is offered
  | "on"            // installed by Mosh: Remove is offered
  | "partial"       // installed by Mosh but transcription is missing: Install finishes it
  | "external";     // present, but set up outside Mosh (the owner's venvs): hands off

export const AI_TOOLS_STEP_LABEL: Record<AiToolsStepId, string> = {
  python: "Python",
  sketch: "Beatbox → beat",
  transcribe: "Transcription",
};

export interface AiToolsSetupView {
  phase: AiToolsPhase;
  status: string;
  size: string;
  canInstall: boolean;
  canCancel: boolean;
  canRemove: boolean;
  /** Friend copy for the failure (or why this build can't add them). */
  error: string;
  /** The install log's last lines, verbatim. */
  detail: string;
  steps: { id: AiToolsStepId; label: string; status: AiToolsStepStatus }[];
}

/** Sizes are stated before the click: "About 0.8 GB". */
export function aiToolsSize(mb: number): string {
  return `About ${((mb > 0 ? mb : 850) / 1024).toFixed(1)} GB`;
}

const UNAVAILABLE = "This build of Mosh can't add AI tools.";

export function aiToolsSetupView(ai: AiToolsSnapshot | undefined, st: AiToolsInstallStatus): AiToolsSetupView {
  // No aiTools in the snapshot: a backend older than the gate, where everything is present.
  const on = ai ? ai.state === "on" : true;
  const managed = ai?.pythonSource === "managed";
  const phase: AiToolsPhase =
    st.state === "installing" || st.state === "cancelling" || st.state === "removing" ? st.state
    : on && !managed ? "external"
    : !st.available ? "unavailable"
    : st.state === "failed" ? "failed"
    : on ? (ai?.pack.transcribe === "ok" ? "on" : "partial")
    : "off";
  const running = st.steps.find((s) => s.status === "running");
  const status = {
    unavailable: st.error || UNAVAILABLE,
    off: "Not installed",
    installing: running ? `Installing ${AI_TOOLS_STEP_LABEL[running.id]}…` : "Installing…",
    cancelling: "Stopping…",
    removing: "Removing…",
    failed: "Didn't finish",
    on: "On",
    partial: "On, transcription missing",
    external: "On (set up outside Mosh)",
  }[phase];
  return {
    phase,
    status,
    size: aiToolsSize(st.sizeEstimateMb),
    canInstall: st.available && (phase === "off" || phase === "failed" || phase === "partial"),
    canCancel: phase === "installing",
    canRemove: st.available && (phase === "on" || phase === "partial"),
    error: phase === "failed" ? st.error : "",
    detail: phase === "failed" ? st.detail : "",
    steps: st.steps.map((s) => ({ ...s, label: AI_TOOLS_STEP_LABEL[s.id] })),
  };
}

/** Whether the Start page's Ready step offers the setup at all. Never when the tools are
 *  already here or this build can't add them; always while a job is running or just ended
 *  badly, so the friend can see it. */
export function offerAiTools(view: AiToolsSetupView): boolean {
  return view.phase === "off" || view.phase === "failed" || view.phase === "installing"
    || view.phase === "cancelling";
}

/** The installer's live status: read once on mount, then from every ai_tools event. Each
 *  action answers with the new status too, so a click shows at once even without events.
 *  `status` is null until the first answer, so nothing offers an Install that can't work. */
export function useAiToolsInstaller() {
  const [status, setStatus] = useState<AiToolsInstallStatus | null>(null);
  useEffect(() => {
    let live = true;
    void aiToolsStatus().then((s) => { if (live) setStatus(s); });
    const off = onEvent("ai_tools", (raw) => { if (live) setStatus(parseAiToolsInstallStatus(raw)); });
    return () => { live = false; off(); };
  }, []);
  return {
    status,
    install: async () => setStatus(await aiToolsInstall()),
    cancel: async () => setStatus(await aiToolsCancel()),
    remove: async () => setStatus(await aiToolsRemove()),
  };
}
