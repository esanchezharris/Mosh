import { useMemo } from "react";
import { useStore } from "../store";
import { meterFrom } from "../time";
import { deriveLocalAgentJobs } from "./agent/localAgentJobs";
import { useShell } from "./shellState";

export function StatusStrip() {
  const snapshot = useStore((state) => state.snapshot);
  const peers = useStore((state) => state.peers);
  const mp = useStore((state) => state.mp);
  const renderProgress = useStore((state) => state.renderProgress);
  const agentBusy = useStore((state) => state.agentBusy);
  const jobs = useMemo(
    () => deriveLocalAgentJobs(snapshot, renderProgress, agentBusy),
    [snapshot, renderProgress, agentBusy],
  );
  if (!snapshot) return null;
  const meter = meterFrom(snapshot.session);
  const humans = Object.keys(peers).length + 1;

  return (
    <footer className="v2-status-strip" data-testid="v2-status-strip">
      <span>{snapshot.session.key?.tonic ?? "C"}{snapshot.session.key?.mode === "minor" ? "m" : ""}</span>
      <span>{meter.num}/{meter.den}</span>
      <span>{Math.round(snapshot.session.sampleRate / 1000)} kHz</span>
      <span>{mp.active ? `Multiplayer session · ${humans} humans` : "Local session"}</span>
      {jobs.length > 0 && (
        <button
          className="v2-status-jobs"
          data-testid="v2-status-jobs"
          onClick={() => useShell.getState().openRailTab("agent")}
        >
          <span className="v2-status-job-dot" />
          {jobs.length} AI {jobs.length === 1 ? "job" : "jobs"} running
        </button>
      )}
    </footer>
  );
}
