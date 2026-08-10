// The live shell's control bar (SPEC §3) — Live's 28pt top strip, left → right:
// tempo · meter · metronome | position · transport | loop · draw · computer-keyboard |
// sample-rate stub · ONE Moshi spark · overflow. Every mutation is an existing command
// through store.exec; transport reuses v2's useTransportControls verbatim (same arm /
// enqueue / failure semantics), and the position readout subscribes to the live 30Hz
// store transport field exactly like v2's TopBar.
//
// Skipped per SPEC §3/§10: Link, Tap, key signature, follow, punch, Key/MIDI map modes,
// CPU meter. The "48.0 kHz" readout is the session's real sample rate, not decoration.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { tempoMapFrom, secondsToBBSMap, meterFrom, barSeconds } from "../time";
import { useTransportControls } from "../v2/useTransportControls";
import { MoshTip } from "../chrome/Tooltip";
import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { qwertyState, onQwertyChange, setQwertyActive } from "../hooks/useQwertyMidi";
import { loopToggleArgs } from "./transportBar";
import { useLive } from "./liveState";
import type { Snapshot } from "../types";
import {
  IconKeys, IconMore, IconPause, IconPlay, IconSkipStart, IconSpark, IconStop,
} from "../ui/icons";

export function ControlBar({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const t = useStore((s) => s.transport);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const anyArmed = snapshot.tracks.some((tr) => tr.armed);
  const fallbackTrackId = selectedTrackId
    ?? snapshot.tracks.find((tr) => tr.type === "audio")?.id
    ?? snapshot.tracks[0]?.id;
  const transport = useTransportControls({ exec, anyArmed, fallbackTrackId });

  const map = tempoMapFrom(snapshot.session);
  const meter = meterFrom(snapshot.session);
  const bbs = secondsToBBSMap(map, t.position);
  const barLen = barSeconds(meter);
  const metronomeOn = Boolean(snapshot.session.metronome);
  const looping = t.looping;
  const drawMode = useLive((s) => s.drawMode);
  const toggleDrawMode = useLive((s) => s.toggleDrawMode);
  const automationView = useLive((s) => s.automationView);
  const toggleAutomationView = useLive((s) => s.toggleAutomationView);
  const moshiOpen = useLive((s) => s.moshiOpen);
  const toggleMoshi = useLive((s) => s.toggleMoshi);

  return (
    <header className="live-controlbar" data-testid="live-controlbar">
      {/* tempo · meter · click — Live's left cluster */}
      <div className="live-cb-group">
        <MoshTip side="bottom" label="Tempo (BPM)">
          <input
            className="live-cb-num"
            type="number"
            aria-label="Tempo"
            min={20} max={300}
            key={`bpm-${Math.round(snapshot.session.tempo)}`}
            defaultValue={Math.round(snapshot.session.tempo)}
            data-testid="live-tempo"
            onBlur={(e) => void exec("set_tempo", { bpm: Number(e.target.value) })}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        </MoshTip>
        <span className="live-cb-chip" title="Time signature">{meter.num}/{meter.den}</span>
        <MoshTip side="bottom" label="Metronome">
          <button
            className="live-cb-btn"
            data-testid="live-metronome"
            aria-label="Metronome"
            aria-pressed={metronomeOn}
            data-on={metronomeOn}
            onClick={() => void exec("set_metronome", { enabled: !metronomeOn })}
          >♩</button>
        </MoshTip>
      </div>

      {/* position + transport — the 30Hz store transport field drives both */}
      <div className="live-cb-group live-cb-transport" data-testid="live-transport"
        data-playing={t.playing} data-recording={t.recording}>
        <span className="live-cb-position" data-testid="live-position" title="Position (bars.beats.16ths)">{bbs}</span>
        <MoshTip side="bottom" label="To start">
          <button className="live-cb-btn" aria-label="To start"
            onClick={() => void transport.stop()}><IconSkipStart size={13} /></button>
        </MoshTip>
        <MoshTip side="bottom" label={t.playing ? "Pause" : "Play"}>
          <button className="live-cb-btn play" data-testid="live-play"
            aria-label={t.playing ? "Pause" : "Play"} aria-pressed={t.playing} data-on={t.playing}
            onClick={() => void transport.togglePlay()}>
            {t.playing ? <IconPause size={13} /> : <IconPlay size={13} />}
          </button>
        </MoshTip>
        <MoshTip side="bottom" label="Stop">
          <button className="live-cb-btn" data-testid="live-stop" aria-label="Stop"
            onClick={() => void transport.stop()}><IconStop size={13} /></button>
        </MoshTip>
        <MoshTip side="bottom" label="Record">
          <button className="live-cb-btn rec" data-testid="live-record"
            aria-label="Record" aria-pressed={t.recording} data-on={t.recording}
            onClick={() => void transport.record()}><span className="live-rec-dot" /></button>
        </MoshTip>
      </div>

      {/* loop · draw · computer keyboard */}
      <div className="live-cb-group">
        <MoshTip side="bottom" label={looping ? "Loop is ON — click to turn off" : "Loop — re-arms the last range (first 4 bars if none)"}>
          <button
            className="live-cb-btn"
            data-testid="live-loop"
            aria-label="Loop"
            aria-pressed={looping}
            data-on={looping}
            onClick={() => void exec("set_transport", loopToggleArgs(t, barLen))}
          >⟳</button>
        </MoshTip>
        <span className="live-cb-looprange" data-testid="live-loop-range">
          {secondsToBBSMap(map, t.loopStart)} – {secondsToBBSMap(map, t.loopEnd)}
        </span>
        <MoshTip side="bottom" label="Draw Mode (Pitch Lock Off) — B: the Phase-2 MIDI editor paints notes while this is on">
          <button
            className="live-cb-btn"
            data-testid="live-draw"
            aria-label="Draw mode"
            aria-pressed={drawMode}
            data-on={drawMode}
            onClick={toggleDrawMode}
          >✎</button>
        </MoshTip>
        {/* Live 12's Automation Mode (A) — the top-bar view toggle. The lanes
            themselves are a later wave; the state lives in useLive (UI-local). */}
        <MoshTip side="bottom" label="Automation Mode — A: show/hide automation lanes (lane rendering is a later wave)">
          <button
            className="live-cb-btn"
            data-testid="live-automation-view"
            aria-label="Automation mode"
            aria-pressed={automationView}
            data-on={automationView}
            onClick={toggleAutomationView}
          >A</button>
        </MoshTip>
        <QwertyToggle />
      </div>

      <div className="live-cb-spacer" />

      {/* sample-rate readout · the ONE Moshi button (SPEC §11) · overflow */}
      <div className="live-cb-group live-cb-right">
        <span className="live-cb-chip dim" title="Session sample rate">
          {(snapshot.session.sampleRate / 1000).toFixed(1)} kHz
        </span>
        <MoshTip side="bottom" label="Moshi — the agent drawer (collapsed by default; the full composer lives in the Mosh shell today)">
          <button
            className="live-cb-btn moshi"
            data-testid="live-moshi"
            aria-label="Toggle the Moshi drawer"
            aria-pressed={moshiOpen}
            data-on={moshiOpen}
            onClick={toggleMoshi}
          ><IconSpark size={13} /></button>
        </MoshTip>
        <ShellMenu />
      </div>
    </header>
  );
}

// The computer-keyboard-as-MIDI toggle (Live's "keys" button). qwertyState is a
// module-level instrument (see hooks/useQwertyMidi.ts — capture-phase claiming IS the
// Ableton single-letter rule), so this subscribes to its change listener rather than
// to a store.
function QwertyToggle() {
  const [active, setActive] = useState(qwertyState.active);
  useEffect(() => onQwertyChange((s) => setActive(s.active)), []);
  return (
    <MoshTip side="bottom" label="Computer MIDI keyboard — A–K play the selected track; single-letter shortcuts need Shift while on">
      <button
        className="live-cb-btn"
        data-testid="live-qwerty"
        aria-label="Computer MIDI keyboard"
        aria-pressed={active}
        data-on={active}
        onClick={() => setQwertyActive(!active)}
      ><IconKeys size={13} /></button>
    </MoshTip>
  );
}

// The way OUT: the clone is reversible, so the switcher rides the overflow menu —
// same seam as v2's "Switch to Classic UI" (a UI-local setting write, never a command).
function ShellMenu() {
  const setShell = useSettings((s) => s.set);
  return (
    <MoshMenu
      label="Live shell options"
      align="end"
      trigger={
        <button className="live-cb-btn" data-testid="live-menu" aria-label="Shell options" aria-haspopup="menu">
          <IconMore size={13} />
        </button>
      }
    >
      <div className="live-menu" role="menu">
        <MoshMenuItem testId="live-switch-protools" ariaLabel="Switch to the Pro Tools interface"
          onPick={() => setShell("uiShell", "protools")}>
          Switch to Pro Tools
        </MoshMenuItem>
        <MoshMenuItem testId="live-switch-v2" ariaLabel="Switch to the Mosh (new) interface"
          onPick={() => setShell("uiShell", "v2")}>
          Switch to Mosh (new)
        </MoshMenuItem>
        <MoshMenuItem testId="live-switch-classic" ariaLabel="Switch to the Classic interface"
          onPick={() => setShell("uiShell", "classic")}>
          Switch to Classic
        </MoshMenuItem>
      </div>
    </MoshMenu>
  );
}
