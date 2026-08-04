// CAP-TRN-005 — the metronome's sound, level and routing.
//
// The ♩ button keeps doing exactly what it did: one click toggles the click. A click you
// have to open a panel to silence is worse than the bare toggle we had. The settings sit
// behind a disclosure caret beside it — the same shape the bar already uses for Snap
// (toggle + division), and the same progressive-disclosure bet RecordOptionsChip makes:
// level is the only one of these a producer touches often, and even that is once a
// session.
//
// The panel sits next to Count-in and Rec on purpose. Those three are the "what do I hear
// and what happens when I hit record" cluster, and count-in plays THROUGH this click —
// tracktion's performRecord calls setClickTrackRange for the pre-roll — so a producer who
// turned the count-in on and heard nothing is looking for the level, right here.
//
// Routing needs an enumeration the snapshot deliberately does not carry (device lists stay
// behind on-demand list_audio_devices, so the 30Hz-refetched snapshot stays small), so the
// panel loads it ON OPEN through the store's existing lazy catalog slice — the same one
// Settings uses, not a second fetch path. On open is also the only safe time:
// execute_command runs synchronously on the UI thread, so a fetch at mount would pay the
// device scan on every session start for a panel almost nobody opens.

import { useEffect } from "react";
import { useStore } from "../store";
import { useAnchoredPanel } from "../hooks/useAnchoredPanel";
import { pickFiles, isNative } from "../bridge";
import type { ClickSettings, Snapshot } from "../types";
import {
  DEFAULT_CLICK, clickLevelDb, clickSoundLabel, clickOutputOptions,
  selectedClickOutput, isMidiClickOutput,
} from "./metronome";

/** The ♩ toggle plus its settings panel. Rendered as one group so the two read as a
 *  single control, the way `.v2-snap-controls` pairs its toggle with its division.
 *
 *  Session state arrives as a PROP, like everything else TopBar renders — the store is
 *  only for `exec` and the lazy device catalog. (RecordOptionsChip reads the store
 *  instead; both work, but a bar control that quietly ignored the snapshot its parent was
 *  handed would be a second source of truth inside one header.) An older backend sends no
 *  `click` block, which is what DEFAULT_CLICK is for. */
export function MetronomeControls({ session }: { session: Snapshot["session"] }) {
  const exec = useStore((s) => s.exec);
  const enabled = Boolean(session.metronome);
  const click: ClickSettings = session.click ?? DEFAULT_CLICK;

  // 300 MUST match `.v2-click-panel { width }` in css/20-topbar.css — the hook clamps the
  // panel into the viewport with this number, so a disagreement mis-places it on a narrow
  // window (the bug RecordPanel already paid for once).
  const { open, at, anchorRef, panelRef, toggle } = useAnchoredPanel(300, 380, "start");
  const loadAudioDevices = useStore((s) => s.loadAudioDevices);
  // A backend without clickOutputs (or a headless/web run) leaves this undefined, which
  // clickOutputOptions renders as "just the default" rather than an empty picker.
  const outputs = useStore((s) => s.audioDevices?.clickOutputs);

  useEffect(() => { if (open) void loadAudioDevices(); }, [open, loadAudioDevices]);

  const set = (patch: Partial<ClickSettings>) => void exec("set_metronome", patch);

  const selected = selectedClickOutput(click.outputDevice, click.defaultOutputDevice);
  const options = clickOutputOptions(outputs, click.outputDevice, click.defaultOutputDevice);
  const midiRouted = isMidiClickOutput(outputs, selected);

  // Everything that would SURPRISE you on the next bar, in the tooltip — the chip itself
  // stays a caret, because the bar already carries seven controls.
  const title = `Metronome click: level ${clickLevelDb(click.level)}`
    + `, downbeat accent ${click.emphasizeBars ? "on" : "off"}`
    + `, ${click.recordingOnly ? "only while recording" : "always audible"}`
    + `, out to ${click.outputDeviceResolved}`;

  const browse = async (which: "soundBig" | "soundSmall") => {
    const r = await pickFiles({ filters: "*.wav", title: "Choose a click sound (WAV)" });
    if (r.ok && r.files[0]) set({ [which]: r.files[0] } as Partial<ClickSettings>);
  };

  return (
    /* "Metronome controls", not "Metronome": the toggle inside is already labelled
       "Metronome", and two nodes sharing one accessible name makes the group and the
       control it wraps indistinguishable to a screen reader (and to a querySelector).
       Mirrors the "Snap controls" group beside it. */
    <span className="v2-click-controls v2-menu-wrap" role="group" aria-label="Metronome controls">
      <button className="v2-chip v2-chip-toggle" aria-label="Metronome" aria-pressed={enabled}
        data-on={enabled} title="Metronome click"
        onClick={() => void exec("set_metronome", { enabled: !enabled })}>♩</button>
      <button ref={anchorRef} className="v2-chip v2-click-more" data-testid="v2-click-more"
        aria-label="Metronome settings" aria-haspopup="dialog" aria-expanded={open}
        title={title} onClick={toggle}>⌄</button>

      {open && at && (
        <div ref={panelRef} className="v2-menu-panel v2-menu-panel-fixed v2-click-panel"
          style={{ left: at.left, top: at.top, bottom: at.bottom }}
          role="dialog" aria-label="Metronome settings" data-testid="v2-click-panel">

          <label className="v2-rec-row">
            <span><b>Level</b>
              {/* Said out loud because the engine enforces it: getClickTrackVolume()
                  re-clamps to [0.2, 1.0] on every read, so the bottom of this slider is
                  a quiet click, never a silent one. */}
              <em>The click will not go below {clickLevelDb(click.levelMin)} — to silence it, turn it off.</em>
            </span>
            <span className="v2-rec-retro">
              <input type="range" data-testid="v2-click-level"
                aria-label="Metronome level"
                min={click.levelMin} max={click.levelMax} step={0.01} value={click.level}
                onChange={(e) => set({ level: Number(e.target.value) })} />
              <span className="tc">{clickLevelDb(click.level)}</span>
            </span>
          </label>

          <label className="v2-rec-row">
            <input type="checkbox" data-testid="v2-click-emphasis" checked={click.emphasizeBars}
              onChange={(e) => set({ emphasizeBars: e.target.checked })} />
            <span>
              <b>Accent the downbeat</b>
              <em>The first beat of each bar gets the louder click, so you can hear where bar one is.</em>
            </span>
          </label>

          <label className="v2-rec-row">
            <input type="checkbox" data-testid="v2-click-rec-only" checked={click.recordingOnly}
              onChange={(e) => set({ recordingOnly: e.target.checked })} />
            <span>
              <b>Only while recording</b>
              <em>Silent during playback. The count-in still clicks.</em>
            </span>
          </label>

          <label className="v2-rec-row">
            <span><b>Output</b>
              {/* The stored name and the resolved one are two different fields for a
                  reason — an interface that is not plugged in right now still keeps its
                  route, and the engine falls back to the default meanwhile. Say which. */}
              {selected !== click.outputDeviceResolved && (
                <em>Not available right now — the click is going to {click.outputDeviceResolved}.</em>
              )}
            </span>
            <select data-testid="v2-click-output" value={selected}
              onChange={(e) => set({ outputDevice: e.target.value })}>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          <ClickSoundRow label="Downbeat sound" testId="v2-click-sound-big"
            path={click.soundBig} onBrowse={() => void browse("soundBig")}
            onReset={() => set({ soundBig: "" })} />
          <ClickSoundRow label="Other beats" testId="v2-click-sound-small"
            path={click.soundSmall} onBrowse={() => void browse("soundSmall")}
            onReset={() => set({ soundSmall: "" })} />

          {/* Revealed only on a MIDI route: ClickGenerator reads these notes in its midi
              branch alone, so on an audio out they are two dials that do nothing. */}
          {midiRouted && (
            <>
              <label className="v2-rec-row">
                <span><b>Downbeat note</b><em>MIDI note sent on channel 10.</em></span>
                <input className="v2-chip v2-chip-num" type="number" data-testid="v2-click-note-big"
                  aria-label="Downbeat MIDI note" min={0} max={127}
                  key={`note-big-${click.midiNoteBig}`} defaultValue={click.midiNoteBig}
                  onBlur={(e) => set({ midiNoteBig: Number(e.target.value) })}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              </label>
              <label className="v2-rec-row">
                <span><b>Other-beat note</b><em>MIDI note sent on channel 10.</em></span>
                <input className="v2-chip v2-chip-num" type="number" data-testid="v2-click-note-small"
                  aria-label="Other-beat MIDI note" min={0} max={127}
                  key={`note-small-${click.midiNoteSmall}`} defaultValue={click.midiNoteSmall}
                  onBlur={(e) => set({ midiNoteSmall: Number(e.target.value) })}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              </label>
            </>
          )}
        </div>
      )}
    </span>
  );
}

/** One click-sample row. Browse is hidden outside the native app because pickFiles has no
 *  web fallback — a button that can only ever return {ok:false} is worse than no button. */
function ClickSoundRow(
  { label, testId, path, onBrowse, onReset }:
  { label: string; testId: string; path: string; onBrowse: () => void; onReset: () => void },
) {
  return (
    <div className="v2-rec-row v2-click-sound">
      <span><b>{label}</b><em title={path || undefined}>{clickSoundLabel(path)}</em></span>
      <span className="v2-click-sound-actions">
        {isNative() && (
          <button className="v2-chip" data-testid={testId} onClick={onBrowse}>Browse…</button>
        )}
        {path !== "" && (
          <button className="v2-chip" data-testid={`${testId}-reset`} aria-label={`Reset ${label}`}
            title="Restore the built-in click" onClick={onReset}>×</button>
        )}
      </span>
    </div>
  );
}
