// v2 top bar: project meta (name · key · tempo · time-sig), the transport cluster,
// the timecode/loop readout, an AI-status pill, Share (multiplayer), and an overflow
// menu for app/session concerns (save/export/theme/switch-shell). Transport reads the
// live 30Hz store field; every mutation is an existing command through store.exec.

import { useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { tempoMapFrom, secondsToBBSMap, meterFrom, barSeconds } from "../time";
import { TONICS, MODES, DEFAULT_KEY } from "../musicalKey";
import { TrainingTool, CommandLogTool, RemoteTool, MultiplayerTool, HelpTool } from "../ui/TopbarTools";
import type { Snapshot } from "../types";

function projectName(editFile: string): string {
  const base = editFile.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "") || "Untitled";
}

export function TopBar({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const t = useStore((s) => s.transport);
  const agentBusy = useStore((s) => s.agentBusy);
  const mpCreate = useStore((s) => s.mpCreateSession);
  const mpActive = useStore((s) => s.mp.active);

  const map = tempoMapFrom(snapshot.session);
  const meter = meterFrom(snapshot.session);
  const bbs = secondsToBBSMap(map, t.position);
  const barLen = barSeconds(meter);
  const loopBars = Math.max(1, Math.round((t.loopEnd - t.loopStart) / barLen));
  const totalBars = Math.max(1, Math.round((snapshot.session.length ?? 0) / barLen));
  const key = snapshot.session.key ?? DEFAULT_KEY;

  return (
    <header className="v2-topbar" data-testid="v2-topbar">
      <div className="v2-proj">
        <span className="v2-proj-name" title={snapshot.session.editFile}>{projectName(snapshot.session.editFile)}</span>
        <div className="v2-proj-meta">
          <select className="v2-chip" aria-label="Key tonic" value={key.tonic}
            onChange={(e) => void exec("set_key", { tonic: e.target.value, mode: key.mode })}>
            {TONICS.map((tn) => <option key={tn} value={tn}>{tn}</option>)}
          </select>
          <select className="v2-chip" aria-label="Key mode" value={key.mode}
            onChange={(e) => void exec("set_key", { tonic: key.tonic, mode: e.target.value })}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input className="v2-chip v2-chip-num" type="number" aria-label="Tempo" min={20} max={300}
            defaultValue={Math.round(snapshot.session.tempo)}
            onBlur={(e) => void exec("set_tempo", { bpm: Number(e.target.value) })}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          <span className="v2-chip" title="Time signature">{meter.num}/{meter.den}</span>
        </div>
      </div>

      <div className="v2-transport" data-testid="v2-transport" data-playing={t.playing} data-recording={t.recording}>
        <button className="v2-tbtn" title="To start" aria-label="To start"
          onClick={() => void exec("set_transport", { action: "stop", position: 0 })}>⏮</button>
        <button className="v2-tbtn play" data-on={t.playing} data-testid="v2-play"
          aria-pressed={t.playing} aria-label={t.playing ? "Pause" : "Play"} title={t.playing ? "Pause" : "Play"}
          onClick={() => void exec("set_transport", { action: "toggle" })}>{t.playing ? "⏸" : "▶"}</button>
        <button className="v2-tbtn" title="Stop" aria-label="Stop" data-testid="v2-stop"
          onClick={() => void exec("set_transport", { action: "stop", position: 0 })}>⏹</button>
        <button className="v2-tbtn rec" data-on={t.recording} title="Record" aria-label="Record" data-testid="v2-record"
          onClick={() => void exec("set_transport", { action: "record" })}><span className="dot" /></button>

        <div className="v2-readout">
          <span className="v2-time" data-testid="v2-time">{bbs}</span>
          <span className="v2-bars">
            <span>{t.looping ? loopBars : totalBars} bars</span>
            <span className={t.looping ? "v2-loop-on" : ""}>{t.looping ? "loop" : "—"}</span>
          </span>
        </div>
      </div>

      <div className="v2-spacer" />

      <span className="v2-pill" title="Moshi is in the session">
        <span className={`led${agentBusy ? " busy" : ""}`} />
        AI {agentBusy ? "working" : "active"}
      </span>

      <button className="v2-btn" data-testid="v2-share" onClick={() => { if (!mpActive) void mpCreate(); }}>
        ⤴ {mpActive ? "Shared" : "Share"}
      </button>

      {/* app/session tools reused from the classic cluster — every feature keeps a home */}
      <div className="v2-tools" data-testid="v2-tools">
        <MultiplayerTool />
        <TrainingTool training={snapshot.training ?? null} />
        <CommandLogTool />
        <RemoteTool />
        <HelpTool />
      </div>

      <OverflowMenu />
    </header>
  );
}

function OverflowMenu() {
  const [open, setOpen] = useState(false);
  const exec = useStore((s) => s.exec);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setShell = useSettings((s) => s.set);
  const item = (label: string, fn: () => void, kbd?: string) => (
    <button onClick={() => { setOpen(false); fn(); }}>{label}{kbd && <kbd>{kbd}</kbd>}</button>
  );

  return (
    <div className="v2-menu-wrap">
      <button className="v2-btn icon" aria-label="More" aria-haspopup="menu" aria-expanded={open}
        data-testid="v2-overflow" onClick={() => setOpen((o) => !o)}>⋯</button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => setOpen(false)} />
          <div className="v2-menu" role="menu">
            {item("Undo", () => void exec("undo"), "⌘Z")}
            {item("Redo", () => void exec("redo"), "⇧⌘Z")}
            <div className="v2-menu-sep" />
            {item("Toggle theme", () => toggleTheme())}
            {item("Switch to Classic UI", () => setShell("uiShell", "classic"))}
          </div>
        </>
      )}
    </div>
  );
}
