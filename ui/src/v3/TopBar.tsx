// Open Lanes (v3) top bar — MOSH brand + project meta on the left, a transport pill +
// BBT readout in the center, an AI pill + collaborator cluster + invite + overflow on the
// right. Transparent bar; each cluster floats. Reads the live 30Hz store.transport; every
// mutation is an existing command through store.exec — identical seam to the v2 TopBar.

import { useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { tempoMapFrom, secondsToBBSMap, meterFrom, barSeconds } from "../time";
import { TONICS, MODES, DEFAULT_KEY } from "../musicalKey";
import type { Snapshot } from "../types";
import { IconMore, IconPause, IconPlay, IconSkipStart, IconStop, IconUsers } from "../ui/icons";

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
    <header className="ol-topbar" data-testid="v3-topbar">
      <div className="ol-brand">
        <span className="ol-logo">MOSH</span>
        <div className="ol-meta">
          <select className="ol-chip" aria-label="Key tonic" value={key.tonic}
            onChange={(e) => void exec("set_key", { tonic: e.target.value, mode: key.mode })}>
            {TONICS.map((tn) => <option key={tn} value={tn}>{tn}</option>)}
          </select>
          <select className="ol-chip" aria-label="Key mode" value={key.mode}
            onChange={(e) => void exec("set_key", { tonic: key.tonic, mode: e.target.value })}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input className="ol-chip ol-chip-num" type="number" aria-label="Tempo" min={20} max={300}
            key={`bpm-${Math.round(snapshot.session.tempo)}`}
            defaultValue={Math.round(snapshot.session.tempo)}
            onBlur={(e) => void exec("set_tempo", { bpm: Number(e.target.value) })}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          <span className="ol-timesig" title="Time signature">
            <input className="ol-chip ol-chip-num" type="number" aria-label="Time signature numerator" min={1} max={32}
              key={`ts-num-${meter.num}`} defaultValue={meter.num}
              onBlur={(e) => void exec("set_time_signature", { numerator: Number(e.target.value), denominator: meter.den })}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <span className="ol-timesig-slash">/</span>
            <input className="ol-chip ol-chip-num" type="number" aria-label="Time signature denominator" min={1} max={32}
              key={`ts-den-${meter.den}`} defaultValue={meter.den}
              onBlur={(e) => void exec("set_time_signature", { numerator: meter.num, denominator: Number(e.target.value) })}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </span>
          <button className="ol-chip" aria-label="Metronome" aria-pressed={Boolean(snapshot.session.metronome)}
            data-on={Boolean(snapshot.session.metronome)} title="Metronome click"
            onClick={() => void exec("set_metronome", { enabled: !snapshot.session.metronome })}>♩</button>
          <span className="ol-nm-proj" title={snapshot.session.editFile}
            style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--ol-faint)", textTransform: "uppercase" }}>
            {projectName(snapshot.session.editFile)}
          </span>
        </div>
      </div>

      <div className="ol-center">
        <div className="ol-transport" data-testid="v3-transport" data-playing={t.playing} data-recording={t.recording}>
          <button className="ol-tbtn" title="To start" aria-label="To start"
            onClick={() => void exec("set_transport", { action: "stop", position: 0 })}><IconSkipStart size={14} /></button>
          <button className="ol-tbtn play" data-on={t.playing} data-testid="v3-play"
            aria-pressed={t.playing} aria-label={t.playing ? "Pause" : "Play"} title={t.playing ? "Pause" : "Play"}
            onClick={() => void exec("set_transport", { action: "toggle" })}>{t.playing ? <IconPause size={14} /> : <IconPlay size={14} />}</button>
          <button className="ol-tbtn" title="Stop" aria-label="Stop" data-testid="v3-stop"
            onClick={() => void exec("set_transport", { action: "stop", position: 0 })}><IconStop size={14} /></button>
          <button className="ol-tbtn rec" data-on={t.recording} title="Record" aria-label="Record" data-testid="v3-record"
            onClick={() => void exec("set_transport", { action: "record" })}><span className="dot" /></button>
        </div>
        <div className="ol-readout">
          <span className="ol-time" data-testid="v3-time">{bbs}</span>
          <span className="ol-bars">
            {t.looping ? `${loopBars} bar loop` : `${totalBars} bars`}
            {t.looping && <span className="ol-loop-on"> · loop</span>}
          </span>
        </div>
      </div>

      <div className="ol-top-right">
        <span className="ol-ai" title="Moshi is in the session">
          <span className={`ol-led${agentBusy ? " busy" : ""}`} />
          AI {agentBusy ? "working" : "active"}
        </span>
        <AvatarCluster />
        <button className="ol-btn" data-testid="v3-share" onClick={() => { if (!mpActive) void mpCreate(); }}>
          <IconUsers size={13} /><span>{mpActive ? "Shared" : "Invite"}</span>
        </button>
        <OverflowMenu />
      </div>
    </header>
  );
}

function AvatarCluster() {
  const peers = useStore((s) => s.peers);
  const selfPeer = useStore((s) => s.mp.selfPeer);
  const others = Object.entries(peers).filter(([id]) => id !== selfPeer);
  if (others.length === 0) return null;
  const shown = others.slice(0, 4);
  const extra = others.length - shown.length;
  return (
    <div className="ol-avatars" data-testid="v3-avatars" title={`${others.length} in the session`}>
      {shown.map(([id, p]) => (
        <span key={id} className="ol-avatar" style={{ background: p.color }} title={p.name}>
          {(p.name || "?").charAt(0).toUpperCase()}
        </span>
      ))}
      {extra > 0 && <span className="ol-avatar more">+{extra}</span>}
    </div>
  );
}

function OverflowMenu() {
  const [open, setOpen] = useState(false);
  const exec = useStore((s) => s.exec);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setShell = useSettings((s) => s.set);
  const item = (label: string, fn: () => void, kbd?: string) => (
    <button role="menuitem" onClick={() => { setOpen(false); fn(); }}>{label}{kbd && <kbd>{kbd}</kbd>}</button>
  );
  return (
    <div className="ol-menu-wrap">
      <button className="ol-btn" aria-label="More" aria-haspopup="menu" aria-expanded={open}
        data-testid="v3-overflow" onClick={() => setOpen((o) => !o)}><IconMore size={13} /></button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => setOpen(false)} />
          <div className="ol-menu-panel" role="menu">
            {item("Undo", () => void exec("undo"), "⌘Z")}
            {item("Redo", () => void exec("redo"), "⇧⌘Z")}
            <div className="ol-menu-sep" />
            {item(theme === "light" ? "Dark mode" : "Light mode", () => toggleTheme())}
            <div className="ol-menu-sep" />
            {item("Switch to Mosh (v2)", () => setShell("uiShell", "v2"))}
            {item("Switch to Classic", () => setShell("uiShell", "classic"))}
          </div>
        </>
      )}
    </div>
  );
}
