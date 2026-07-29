import { useMemo, useState } from "react";
import moshIconUrl from "../assets/MoshIcon32.png";
import { useStore } from "../../store";
import { AgentComposer } from "../../ui/AgentComposer";
import { GenDrawer } from "../../ui/GenDrawer";
import { resolveSa3Available } from "../../ui/engineBadge";
import { useTaskStore } from "../../agent/loop/taskStore";
import { AgentDrawer } from "./AgentDrawer";
import { useShell } from "../shellState";
import {
  deriveLocalAgentJobs,
  runArranger,
  runDrummer,
  runGenerator,
  selectedClip,
} from "./localAgentJobs";

export function LocalAgentPanel() {
  const snapshot = useStore((state) => state.snapshot);
  const exec = useStore((state) => state.exec);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const renderProgress = useStore((state) => state.renderProgress);
  const agentBusy = useStore((state) => state.agentBusy);
  const availableColors = useStore((state) => state.availableColors);
  const sa3Available = useStore((state) => state.sa3Available);
  const selectedClipId = useShell((state) => state.selectedClipId);
  const timeRange = useShell((state) => state.timeRange);
  const clearRange = useShell((state) => state.setTimeRange);
  const [notice, setNotice] = useState<string | null>(null);
  const hasTask = useTaskStore((state) => state.current !== null || state.last !== null);
  const drawerOpen = useTaskStore((state) => state.drawerOpen);
  const setDrawerOpen = useTaskStore((state) => state.setDrawerOpen);

  const jobs = useMemo(
    () => deriveLocalAgentJobs(snapshot, renderProgress, agentBusy),
    [snapshot, renderProgress, agentBusy],
  );
  const clip = selectedClip(snapshot, selectedClipId);
  const clipTrack = clip
    ? snapshot?.tracks.find((track) => track.clips.some((candidate) => candidate.id === clip.id)) ?? null
    : null;
  const selectedTrack = snapshot?.tracks.find((track) => track.id === selectedTrackId) ?? null;
  const targetTrack = clipTrack ?? selectedTrack;
  const stableAudio = resolveSa3Available(sa3Available, availableColors.length);

  const runWithNotice = async (worker: "Drummer" | "Arranger" | "Generator") => {
    setNotice(null);
    if (worker === "Drummer") {
      await runDrummer(exec, snapshot, selectedTrackId);
      return;
    }
    if (worker === "Arranger") {
      const started = await runArranger(exec, snapshot, selectedTrackId, timeRange);
      if (!started) {
        setNotice("Select a track, then shift-drag a smaller region over one of its clips.");
        return;
      }
      clearRange(null);
      return;
    }
    const started = await runGenerator(exec, snapshot, selectedClipId, stableAudio);
    if (!started) setNotice("Select a clip first.");
  };

  return (
    <div className="v2-agent-panel" data-testid="v2-agent-panel">
      <section className={`v2-agent-orchestrator${jobs.length > 0 ? " busy" : ""}`}>
        <div className="v2-agent-identity">
          <img src={moshIconUrl} alt="" className="v2-agent-icon" />
          <div>
            <strong>Mosh</strong>
            <span>{jobs.length > 0 ? "Orchestrating locally" : "Ready when you invoke a worker"}</span>
          </div>
          {jobs.length > 0 && <span className="v2-agent-count">{jobs.length}</span>}
          {hasTask && (
            <button
              className="v2-agent-task-toggle"
              data-testid="agent-drawer-toggle"
              onClick={() => setDrawerOpen(!drawerOpen)}
            >
              {drawerOpen ? "Hide task" : "Last task"}
            </button>
          )}
        </div>
        {jobs.length > 0 && (
          <div className="v2-agent-jobs" aria-live="polite" data-testid="v2-agent-jobs">
            {jobs.map((job) => (
              <div className="v2-agent-job" key={job.id} data-worker={job.worker}>
                <div className="v2-agent-job-head">
                  <span>{job.worker}</span>
                  <span>{job.status}</span>
                </div>
                <strong>{job.label}</strong>
                {job.progress !== null && (
                  <div
                    className="v2-agent-progress"
                    role="progressbar"
                    aria-label={`${job.worker} progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(job.progress * 100)}
                  >
                    <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <AgentDrawer />

      <section className="v2-worker-list" aria-label="Local workers">
        <Worker
          name="Drummer"
          description="Lay a two-bar pattern with add_drum_pattern."
          onRun={() => void runWithNotice("Drummer")}
        />
        <Worker
          name="Arranger"
          description="Rework the selected time range as a scoped variation."
          onRun={() => void runWithNotice("Arranger")}
        />
        <Worker
          name="Generator"
          description="Re-imagine the selected clip on this Mac."
          onRun={() => void runWithNotice("Generator")}
        />
      </section>

      {notice && <div className="v2-agent-notice" role="status">{notice}</div>}

      <section className="v2-agent-ask">
        <span className="v2-agent-section-label">Ask Mosh</span>
        <AgentComposer />
      </section>

      {targetTrack && (
        <section className="v2-agent-generator" data-testid="v2-agent-generator">
          <span className="v2-agent-section-label">Generator · {clip?.name ?? targetTrack.name}</span>
          <GenDrawer track={targetTrack} selectedClipId={selectedClipId ?? undefined} />
        </section>
      )}
    </div>
  );
}

function Worker({
  name,
  description,
  onRun,
}: {
  name: "Drummer" | "Arranger" | "Generator";
  description: string;
  onRun: () => void;
}) {
  return (
    <button className="v2-worker" data-testid={`v2-worker-${name.toLowerCase()}`} onClick={onRun}>
      <img src={moshIconUrl} alt="" className="v2-worker-icon" />
      <span>
        <strong>{name}</strong>
        <small>{description}</small>
      </span>
      <span className="v2-worker-run">Run</span>
    </button>
  );
}
