import { useStore } from "../store";
import { pickFiles, pickSaveFile } from "../bridge";
import { tempoMapFrom, secondsToBBSMap } from "../time";
import { projectLabel } from "../projectFile";
import { runAction } from "../menuActions";
import type { Snapshot } from "../types";
import { useV3 } from "./shellState";
import { FileMenu } from "./FileMenu";
import { IconClick, IconCountIn, IconLoop, IconSnap } from "./icons";

export function TopBar({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const t = useStore((s) => s.transport);
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const posture = useV3((s) => s.posture);
  const historyOpen = useV3((s) => s.historyOpen);
  const setHistoryOpen = useV3((s) => s.setHistoryOpen);
  const bbs = secondsToBBSMap(tempoMapFrom(snapshot.session), t.position);
  const name = projectLabel(snapshot.session.editFile) || "untitled";
  const rec = !!t.recording;
  const clickOn = !!snapshot.session.metronome;

  return (
    <div className="top" data-testid="v3-topbar">
      <FileMenu title={name} />
      <div className="tp">
        <button type="button" className={`rec${rec ? " on" : ""}`} aria-label="Record"
          data-testid="v3-record"
          onClick={() => void useStore.getState().toggleRecord()} />
        <button type="button" aria-label={t.playing ? "Pause" : "Play"} data-testid="v3-play"
          onClick={() => void exec("set_transport", { action: "toggle" })}>▶</button>
        <button type="button" aria-label="Stop" data-testid="v3-stop"
          onClick={() => void exec("set_transport", { action: "stop" })}>■</button>
        <span className="time">{bbs}</span>
        <span className="bpm">{Math.round(snapshot.session.tempo ?? 120)}</span>
      </div>
      <div className="row tools">
        <button type="button" className="ibtn" title="Loop" aria-label="Loop" aria-pressed={!!t.looping}
          onClick={() => void runAction("loop_toggle", { store: useStore.getState(), pickFiles, pickSaveFile })}>
          <IconLoop />
        </button>
        {posture === "booth" ? (
          <button type="button" className="ibtn" title="Count-in" aria-label="Count-in">
            <IconCountIn />
          </button>
        ) : null}
        <button type="button" className="ibtn" title="Click" aria-label="Click" aria-pressed={clickOn}
          onClick={() => void exec("set_metronome", { enabled: !clickOn })}>
          <IconClick />
        </button>
        {posture === "studio" ? (
          <button type="button" className="ibtn" title="Snap" aria-label="Snap" aria-pressed={!!snap}
            onClick={() => setSnap(!snap)}>
            <IconSnap />
          </button>
        ) : null}
      </div>
      <div className="spacer" />
      <button type="button" className="btn ghost" data-testid="v3-history"
        aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>History</button>
    </div>
  );
}
