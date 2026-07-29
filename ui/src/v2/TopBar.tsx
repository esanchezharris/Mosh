// v2 top bar (concept layout): the chrome floats on the cream page — a brand mark +
// project meta on the left, a dark transport PILL and a light time CARD in the center,
// and an AI pill + collaborator avatar cluster + invite + overflow on the right. The bar
// itself is transparent; each cluster is its own floating surface. Transport reads the
// live 30Hz store field; every mutation is an existing command through store.exec.

import { useCallback, useMemo, useState } from "react";
import moshIconUrl from "./assets/MoshIcon32.png";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { tempoMapFrom, secondsToBBSMap, meterFrom, barSeconds } from "../time";
import { TONICS, MODES, DEFAULT_KEY } from "../musicalKey";
import { TrainingTool, CommandLogTool, RemoteTool, MultiplayerTool, HelpTool, MemoryTool } from "../ui/TopbarTools";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { MultiplayerLauncher } from "./MultiplayerLauncher";
import { pickFiles, pickSaveFile, brainChat } from "../bridge";
import { runAction, PROJECT_MENU, type ActionId } from "../menuActions";
import { RecentProjectList } from "../ui/RecentProjectList";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { FileOptions } from "../ui/FileOptions";
import type { Snapshot } from "../types";
import { IconHelp, IconList, IconMore, IconPause, IconPlay, IconPhone, IconSkipStart, IconSpark, IconStar, IconStop, IconUsers, IconWaveform } from "../ui/icons";
import { useShell } from "./shellState";
import { deriveLocalAgentJobs } from "./agent/localAgentJobs";

function projectName(editFile: string): string {
  const base = editFile.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "") || "Untitled";
}

export function TopBar({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const t = useStore((s) => s.transport);
  const agentBusy = useStore((s) => s.agentBusy);
  const mpActive = useStore((s) => s.mp.active);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const peerCount = useStore((s) => Object.keys(s.peers).length);
  const renderProgress = useStore((s) => s.renderProgress);
  const openRailTab = useShell((s) => s.openRailTab);

  const map = tempoMapFrom(snapshot.session);
  const meter = meterFrom(snapshot.session);
  const bbs = secondsToBBSMap(map, t.position);
  const loopBars = Math.max(1, Math.round((t.loopEnd - t.loopStart) / barSeconds(meter)));
  const key = snapshot.session.key ?? DEFAULT_KEY;
  const jobs = useMemo(
    () => deriveLocalAgentJobs(snapshot, renderProgress, agentBusy),
    [snapshot, renderProgress, agentBusy],
  );

  // CONF-RECORD-ARM — the Record button used to toggle set_transport{action:"record"}
  // with nothing armed, so a mouse-only user (no keyboard/agent arm step) recorded
  // silence. Mirrors store.enterRecord's fallback (selected → first audio → first
  // track): arm it via arm_track ONLY when starting a fresh recording and no track
  // is armed yet — an already-armed track (or an in-progress recording, where the
  // click just stops it) is left untouched.
  const anyArmed = snapshot.tracks.some((tr) => tr.armed);
  async function handleRecord() {
    if (!t.recording && !anyArmed) {
      const trackId = selectedTrackId ?? snapshot.tracks.find((tr) => tr.type === "audio")?.id ?? snapshot.tracks[0]?.id;
      if (trackId) await exec("arm_track", { trackId, armed: true });
    }
    await exec("set_transport", { action: "record" });
  }

  return (
    <header className="v2-topbar" data-testid="v2-topbar">
      <div className="v2-project-row">
        <div className="v2-brand">
          <img className="v2-app-icon" src={moshIconUrl} alt="Mosh" />
          <span className="v2-wordmark">mosh</span>
          <span className="v2-project-slash">/</span>
          <span className="v2-proj-name" title={snapshot.session.editFile}>{projectName(snapshot.session.editFile)}</span>
          <span className="v2-project-chevron" aria-hidden>⌄</span>
        </div>
        <div className="v2-project-actions">
          <button
            className={`v2-agent-trigger${jobs.length > 0 ? " busy" : ""}`}
            data-testid="v2-agent-trigger"
            onClick={() => openRailTab("agent")}
          >
            <IconSpark size={15} />
            <span>Agents</span>
            {jobs.length > 0 && <span className="v2-agent-trigger-count">{jobs.length}</span>}
          </button>
          <MultiplayerLauncher
            className="v2-btn v2-invite-btn"
            testId="v2-share"
            ariaLabel={mpActive ? "Multiplayer session — view room code" : "Create or join a multiplayer session"}
            label={<><IconUsers size={15} /><span>Share</span></>}
          />
          <FileOptions snapshot={snapshot} />
          <OverflowMenu />
        </div>
      </div>

      <div className="v2-transport-row">
        <div className="v2-transport" data-testid="v2-transport" data-playing={t.playing} data-recording={t.recording}>
          <button className="v2-tbtn" title="To start" aria-label="To start"
            onClick={() => void exec("set_transport", { action: "stop", position: 0 })}><IconSkipStart size={15} /></button>
          <button className="v2-tbtn play" data-on={t.playing} data-testid="v2-play"
            aria-pressed={t.playing} aria-label={t.playing ? "Pause" : "Play"} title={t.playing ? "Pause" : "Play"}
            onClick={() => void exec("set_transport", { action: "toggle" })}>{t.playing ? <IconPause size={15} /> : <IconPlay size={15} />}</button>
          <button className="v2-tbtn" title="Stop" aria-label="Stop" data-testid="v2-stop"
            onClick={() => void exec("set_transport", { action: "stop", position: 0 })}><IconStop size={15} /></button>
          <button className="v2-tbtn rec" data-on={t.recording} data-armed={anyArmed} aria-pressed={t.recording} title="Record" aria-label="Record" data-testid="v2-record"
            onClick={() => void handleRecord()}><span className="dot" /></button>
        </div>

        <div className="v2-readout">
          <label className="v2-readout-cell">
            <span>Position</span>
            <strong className="v2-time" data-testid="v2-time">{bbs}</strong>
          </label>
          <label className="v2-readout-cell">
            <span>Tempo</span>
            <input className="v2-readout-input" type="number" aria-label="Tempo" min={20} max={300}
              key={`bpm-${Math.round(snapshot.session.tempo)}`}
              defaultValue={Math.round(snapshot.session.tempo)}
              onBlur={(e) => void exec("set_tempo", { bpm: Number(e.target.value) })}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </label>
          <label className="v2-readout-cell">
            <span>Meter</span>
            <span className="v2-readout-meter">
              <input className="v2-readout-input" type="number" aria-label="Time signature numerator" min={1} max={32}
                key={`ts-num-${meter.num}`}
                defaultValue={meter.num}
                onBlur={(e) => void exec("set_time_signature", { numerator: Number(e.target.value), denominator: meter.den })}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              <span>/</span>
              <input className="v2-readout-input" type="number" aria-label="Time signature denominator" min={1} max={32}
                key={`ts-den-${meter.den}`}
                defaultValue={meter.den}
                onBlur={(e) => void exec("set_time_signature", { numerator: meter.num, denominator: Number(e.target.value) })}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              {t.looping && (
                <>
                  <span>{loopBars} bars</span>
                  <span className="v2-loop-on">loop</span>
                </>
              )}
            </span>
          </label>
        </div>

        <div className="v2-session-controls">
          <button className="v2-chip v2-chip-toggle" aria-label="Metronome" aria-pressed={Boolean(snapshot.session.metronome)}
            data-on={Boolean(snapshot.session.metronome)} title="Metronome click"
            onClick={() => void exec("set_metronome", { enabled: !snapshot.session.metronome })}><IconWaveform size={14} /></button>
          <select className="v2-chip" aria-label="Count-in" value={snapshot.session.countInBars ?? 0}
            title="Count-in before recording"
            onChange={(e) => void exec("set_count_in", { bars: Number(e.target.value) })}>
            <option value={0}>Count-in off</option>
            <option value={1}>1 bar</option>
            <option value={2}>2 bars</option>
          </select>
          <select className="v2-chip" aria-label="Key tonic" value={key.tonic}
            onChange={(e) => void exec("set_key", { tonic: e.target.value, mode: key.mode })}>
            {TONICS.map((tonic) => <option key={tonic} value={tonic}>{tonic}</option>)}
          </select>
          <select className="v2-chip" aria-label="Key mode" value={key.mode}
            onChange={(e) => void exec("set_key", { tonic: key.tonic, mode: e.target.value })}>
            {MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </div>

        <div className="v2-live-cluster">
          <span className="v2-live-label">Live</span>
          <AvatarCluster />
          <LocalAgentAvatars jobs={jobs.map((job) => job.worker)} />
          <span className="v2-live-count">
            {jobs.length > 0
              ? `${Math.max(1, peerCount + 1)} + ${jobs.length} agents`
              : `${Math.max(1, peerCount + 1)} live`}
          </span>
        </div>
      </div>
    </header>
  );
}

function LocalAgentAvatars({ jobs }: { jobs: string[] }) {
  const workers = [...new Set(jobs)];
  if (workers.length === 0) return null;
  return (
    <div className="v2-agent-avatars" aria-label={`${workers.length} local agents`}>
      {workers.slice(0, 3).map((worker) => (
        <span className="v2-agent-avatar" title={worker} key={worker}>
          <img src={moshIconUrl} alt="" />
        </span>
      ))}
    </div>
  );
}

// Compact collaborator preview near the invite button — initials circles tinted with each
// peer's color, mirroring the full Collaborators rail. Reads the same store.peers; hidden
// solo (renders nothing until someone else is in the session).
function AvatarCluster() {
  const peers = useStore((s) => s.peers);
  const selfPeer = useStore((s) => s.mp.selfPeer);
  const others = Object.entries(peers).filter(([id]) => id !== selfPeer);
  if (others.length === 0) return null;
  const shown = others.slice(0, 4);
  const extra = others.length - shown.length;
  return (
    <div className="v2-avatars" data-testid="v2-avatars" title={`${others.length} in the session`}>
      {shown.map(([id, p]) => (
        <span key={id} className="v2-avatar" style={{ background: p.color }} title={p.name} aria-label={p.name}>
          {(p.name || "?").charAt(0).toUpperCase()}
        </span>
      ))}
      {extra > 0 && <span className="v2-avatar more" aria-label={`${extra} more`}>+{extra}</span>}
    </div>
  );
}

function OverflowMenu() {
  const [open, setOpen] = useState(false);
  // #41/#43 — join the shared Escape STACK so Esc dismisses the menu, and dismisses
  // it FIRST when it sits above another overlay (instead of falling through and
  // closing the modal underneath). The close callback must be render-stable: the
  // stack re-pushes whenever it changes, which would hoist this menu back to the
  // top of the stack on unrelated re-renders.
  const close = useCallback(() => setOpen(false), []);
  useEscapeToClose(open, close);
  const exec = useStore((s) => s.exec);
  const training = useStore((s) => s.snapshot?.training ?? null);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const voiceOn = useStore((s) => s.voiceOn);
  const toggleVoice = useStore((s) => s.toggleVoice);
  const handsFreeOn = useStore((s) => s.handsFreeOn);
  const setHandsFree = useStore((s) => s.setHandsFree);
  const setShell = useSettings((s) => s.set);
  const openBrowserTab = useShell((s) => s.openBrowserTab);
  const arrangementToolsOpen = useShell((s) => s.arrangementToolsOpen);
  const toggleArrangementTools = useShell((s) => s.toggleArrangementTools);
  const item = (label: string, fn: () => void, kbd?: string) => (
    <button role="menuitem" onClick={() => { setOpen(false); fn(); }}>{label}{kbd && <kbd>{kbd}</kbd>}</button>
  );

  return (
    <div className="v2-menu-wrap">
      <button className="v2-btn icon" aria-label="More tools" aria-haspopup="dialog" aria-expanded={open}
        data-testid="v2-overflow" onClick={() => setOpen((o) => !o)}><IconMore size={15} /></button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => setOpen(false)} />
          <div className="v2-menu-panel">
            <div className="v2-menu-tools" data-testid="v2-overflow-tools">
              <MultiplayerTool
                label={<IconUsers size={15} />}
                title="2-player session"
                className="v2-overflow-tool"
                ariaLabel="Open multiplayer tools"
                testId="v2-tool-multiplayer"
              />
              <TrainingTool
                training={training}
                label={<IconSpark size={15} />}
                title="Type-beat training"
                className="v2-overflow-tool"
                ariaLabel="Open training tools"
                testId="v2-tool-training"
              />
              <CommandLogTool
                label={<IconList size={15} />}
                title="Command log"
                className="v2-overflow-tool"
                ariaLabel="Open command log"
                testId="v2-tool-command-log"
              />
              <MemoryTool
                label={<IconStar size={15} />}
                title="What Moshi remembers"
                className="v2-overflow-tool"
                ariaLabel="What Moshi remembers"
                testId="v2-tool-memory"
              />
              <RemoteTool
                label={<IconPhone size={15} />}
                title="Pair iPhone companion"
                className="v2-overflow-tool"
                ariaLabel="Pair iPhone companion"
                testId="v2-tool-remote"
              />
              <HelpTool
                label={<IconHelp size={15} />}
                title="Keyboard shortcuts"
                className="v2-overflow-tool"
                ariaLabel="Keyboard shortcuts"
                testId="v2-tool-help"
              />
            </div>
            <div className="v2-menu" role="menu">
              <ProjectMenuGroup onPick={close} />
              <div className="v2-menu-sep" />
              {item("Undo", () => void exec("undo"), "⌘Z")}
              {item("Redo", () => void exec("redo"), "⇧⌘Z")}
              <div className="v2-menu-sep" />
              {item("Sounds & plugins", () => openBrowserTab("sounds"))}
              {item(arrangementToolsOpen ? "Hide arrangement tools" : "Show arrangement tools", toggleArrangementTools)}
              <div className="v2-menu-sep" />
              {item(voiceOn ? "Mute Moshi" : "Unmute Moshi", () => toggleVoice())}
              {item(handsFreeOn ? "Hands-free: on" : "Hands-free: off", () => setHandsFree(!handsFreeOn))}
              <div className="v2-menu-sep" />
              {item(theme === "light" ? "Dark mode" : "Light mode", () => toggleTheme())}
              {item("Switch to Classic UI", () => setShell("uiShell", "classic"))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Project actions in the overflow menu ─────────────────────────────────────────
// These commands were never UNREACHABLE — FileOptions has rendered FILE_MENU under the
// composer's "+" all along. They were undiscoverable: nobody looking for "start a new
// song" looks at an unlabelled plus glyph next to Moshi's face, tooltipped
// "File · options · export". So this is placement, not plumbing — the same FILE_MENU,
// the same runAction dispatcher, in the menu people actually open.
//
// Exported so its [data-action] sequence can be asserted without mounting the whole
// TopBar, and so projectActionsUnification.test.ts can cover it as a fourth surface.
export function ProjectMenuGroup({ onPick }: { onPick: () => void }) {
  const snapshot = useStore((s) => s.snapshot);
  const [pendingNew, setPendingNew] = useState(false);

  const ctx = () => ({ store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat });
  const run = (id: ActionId, opts?: { index: number }) => { void runAction(id, ctx(), opts); };

  // A track count using the ARRANGEMENT's filter, so the confirm names what the user sees.
  const trackCount = snapshot ? snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn).length : 0;

  const choose = (id: ActionId) => {
    // Gate the one action that discards the current arrangement. Nothing is LOST —
    // MoshEngine::newProject calls save() unconditionally before the swap — so the
    // dialog is about surprise, not data, and the copy says so rather than implying loss.
    // A choice made at the launch picker is NOT gated; only a mid-session one is.
    if (id === "new_project" && trackCount > 0) { setPendingNew(true); return; }
    onPick();
    run(id);
  };

  return (
    <>
      {PROJECT_MENU.map((m) => (
        <button key={m.id} role="menuitem" data-action={m.id} onClick={() => choose(m.id as ActionId)}>
          {m.label}{m.accel && <kbd>{m.accel}</kbd>}
        </button>
      ))}
      <RecentProjectList snapshot={snapshot} variant="menu" onPick={(index) => { onPick(); run("open_recent", { index }); }} />
      {pendingNew && (
        <ConfirmDialog
          title="Start a new project?"
          body={
            <>
              <strong>{snapshot ? projectName(snapshot.session.editFile ?? "") : "This project"}</strong> is saved
              and stays in Recent — you can reopen it any time. The new project starts empty.
            </>
          }
          confirmLabel="New project"
          testId="v2-new-project-confirm"
          onConfirm={() => { setPendingNew(false); onPick(); run("new_project"); }}
          onCancel={() => setPendingNew(false)}
        />
      )}
    </>
  );
}
