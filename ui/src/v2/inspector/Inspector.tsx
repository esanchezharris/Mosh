// The contextual inspector — the single "door" to everything advanced (progressive
// disclosure). It tracks the selected track (always one, auto-selected) and, when a
// clip is selected, its clip context. Tabs appear only when they apply:
//   Mix · FX · Gen   (track)   + MIDI (midi clip) + Takes (clip with >1 take)
// FX and Generative REUSE the classic Dock's Rack + GenDrawer verbatim (same command
// seam) — only Mix/MIDI/Takes are small v2 surfaces. Deep editors (piano-roll, drum,
// automation) open as floating overlays from here.

import { useEffect } from "react";
import { useStore } from "../../store";
import { useShell, type InspectorTab } from "../shellState";
import { Rack, GenDrawer } from "../../ui/Dock";
import { LyricPanel } from "./LyricPanel";
import { deriveTakeLanes } from "../../ui/takeLanes";
import { useDrumWindow } from "../../ui/dock/useFloatingWindow";
import { trackOutputOptions, currentTrackOutput, trackOutputPatch } from "../../settings/routing";
import type { Clip, Track } from "../../types";

export function Inspector() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedClipId = useShell((s) => s.selectedClipId);
  const tab = useShell((s) => s.inspectorTab);
  const setTab = useShell((s) => s.setInspectorTab);

  const track = snapshot?.tracks.find((t) => t.id === selectedTrackId) ?? null;
  if (!track) return null;
  const clip = selectedClipId
    ? snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId)
    : undefined;
  const isMidi = clip?.type === "midi";
  const isWave = clip?.type === "wave";
  const hasTakes = (clip?.numTakes ?? 0) > 1;

  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "mix", label: "Mix" },
    { id: "fx", label: "FX" },
    { id: "gen", label: "Gen" },
    { id: "lyrics", label: "Lyrics" },
    ...(isMidi ? [{ id: "midi" as const, label: "MIDI" }] : []),
    ...(isWave ? [{ id: "warp" as const, label: "Warp" }] : []),
    ...(hasTakes ? [{ id: "takes" as const, label: "Takes" }] : []),
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : "mix";

  return (
    <section className="v2-card v2-inspector" data-testid="v2-inspector">
      <div className="v2-card-head"><span>Inspector · {track.name}</span></div>
      <div className="v2-insp-tabs" role="tablist" aria-label="Inspector tabs">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={active === t.id} className={active === t.id ? "on" : ""}
            data-testid={`v2-insp-tab-${t.id}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="v2-insp-body" data-testid="v2-insp-body">
        {active === "mix" && <MixTab track={track} />}
        {active === "fx" && <Rack track={track} onAddPlugin={() => useShell.getState().openBrowserTab("plugins")} />}
        {active === "gen" && <GenDrawer track={track} selectedClipId={selectedClipId ?? undefined} />}
        {active === "lyrics" && <LyricPanel track={track} />}
        {active === "midi" && clip && <MidiTab clip={clip} drum={track.type === "drum"} />}
        {active === "warp" && clip && <WarpTab clip={clip} />}
        {active === "takes" && clip && <TakesTab clip={clip} />}
      </div>
    </section>
  );
}

function MixTab({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  return (
    <div className="v2-mix">
      <label className="v2-field">
        <span>Vol</span>
        <input type="range" min={-60} max={6} step={0.5} value={track.volumeDb ?? 0}
          onChange={(e) => void exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} />
        <span className="v2-val">{(track.volumeDb ?? 0).toFixed(1)}</span>
      </label>
      <label className="v2-field">
        <span>Pan</span>
        <input type="range" min={-1} max={1} step={0.02} value={track.pan ?? 0}
          onChange={(e) => void exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })} />
        <span className="v2-val">{Math.round((track.pan ?? 0) * 100)}</span>
      </label>
      <OutputField track={track} />
      <div className="v2-mix-btns">
        <button className={track.mute ? "on" : ""} aria-pressed={!!track.mute} onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>Mute</button>
        <button className={track.solo ? "on" : ""} aria-pressed={!!track.solo} onClick={() => void exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>Solo</button>
      </div>
      <SendsSection track={track} />
    </div>
  );
}

// Sends / returns — the per-track door to aux buses. Create a reverb/delay return
// bus, send this track to it, and ride the send level. Every mutation is a MoshOps
// command (create_bus / add_send / set_send_level / remove_send) — no UI-local state.
function SendsSection({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const buses = useStore((s) => s.snapshot?.buses) ?? [];
  const sends = track.sends ?? [];
  return (
    <div className="v2-sends" data-testid="v2-sends">
      <div className="v2-sends-head">
        <span>Sends</span>
        <button className="v2-btn" data-testid="v2-add-bus" onClick={() => void exec("create_bus", {})}>+ Bus</button>
      </div>
      {buses.length === 0 && (
        <div className="v2-sends-empty">No buses yet — add one to send this track to a reverb/delay return.</div>
      )}
      {buses.map((b) => {
        if (b.trackId === track.id) return null; // a return track doesn't send to itself
        const send = sends.find((s) => s.bus === b.bus);
        return (
          <div key={b.bus} className="v2-send-row" data-testid={`v2-send-${b.bus}`}>
            <span className="v2-send-name" title={b.name}>{b.name}</span>
            {send ? (
              <>
                <input type="range" min={-60} max={6} step={0.5} value={send.db}
                  aria-label={`${b.name} send level`}
                  onChange={(e) => void exec("set_send_level", { trackId: track.id, bus: b.bus, db: Number(e.target.value) })} />
                <span className="v2-val">{send.db.toFixed(1)}</span>
                <button className="v2-btn icon" title={`Remove ${b.name} send`} aria-label={`Remove ${b.name} send`}
                  onClick={() => void exec("remove_send", { trackId: track.id, bus: b.bus })}>×</button>
              </>
            ) : (
              <button className="v2-btn" data-testid={`v2-add-send-${b.bus}`}
                onClick={() => void exec("add_send", { trackId: track.id, bus: b.bus, db: 0 })}>Add</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// RTG-002 — per-track output routing. The destination list comes from the
// read-only list_track_outputs enumeration (loaded on mount, lazy + no-op when
// not native); the change rides the existing set_track_output command. One
// mutation path, no new command — just an option list + a decoded patch.
function OutputField({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const loadRouting = useStore((s) => s.loadRouting);
  const trackOutputs = useStore((s) => s.trackOutputs);
  useEffect(() => { void loadRouting(); }, [loadRouting]);

  const opts = trackOutputOptions(trackOutputs, track.id);
  const cur = currentTrackOutput(track);
  // A persisted-but-unlisted destination (e.g. a missing device) still shows its
  // stored name so the picker never silently drops the choice.
  const options = opts.some((o) => o.value === cur)
    ? opts
    : [...opts, { value: cur, label: track.output?.name ?? cur }];

  return (
    <label className="v2-field">
      <span>Out</span>
      <select aria-label={`Output for ${track.name}`} value={cur}
        onChange={(e) => void exec("set_track_output", trackOutputPatch(e.target.value, track.id))}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function MidiTab({ clip, drum }: { clip: Clip; drum: boolean }) {
  const exec = useStore((s) => s.exec);
  const openPianoRoll = useStore((s) => s.openPianoRoll);
  return (
    <div className="v2-mix">
      {drum
        ? <button className="v2-btn primary" data-testid="v2-open-drumgrid" onClick={() => useDrumWindow.getState().open(clip.id)}>Open drum grid</button>
        : <button className="v2-btn primary" data-testid="v2-open-pianoroll" onClick={() => openPianoRoll(clip.id)}>Open piano-roll</button>}
      <button className="v2-btn" onClick={() => void exec("quantize_notes", { clipId: clip.id, division: "1/16", strength: 1 })}>Quantize 1/16</button>
    </div>
  );
}

// Audio warp (auto-tempo): a wave clip re-anchors in beats and time-stretches to follow
// the tempo map. The stretch algorithms the engine compiles in are SoundTouch (native
// cmdSetClipWarp validates the name and falls back to the default if unavailable). The
// toggle enables/disables warp; the mode select re-warps with a new algorithm and is
// inert until warp is on (stretchMode only matters, and is only carried, while warping).
const STRETCH_MODES = ["SoundTouch (Better)", "SoundTouch (Normal)"] as const;

function WarpTab({ clip }: { clip: Clip }) {
  const exec = useStore((s) => s.exec);
  const on = !!clip.autoTempo;
  const mode = clip.stretchMode ?? STRETCH_MODES[0];
  return (
    <div className="v2-mix v2-warp">
      <div className="v2-mix-btns">
        <button className={on ? "on" : ""} aria-pressed={on} data-testid="v2-warp-toggle"
          onClick={() => void exec("set_clip_warp", { clipId: clip.id, autoTempo: !on })}>Warp</button>
      </div>
      <label className="v2-field">
        <span>Stretch</span>
        <select aria-label="Stretch mode" data-testid="v2-warp-mode" value={mode} disabled={!on}
          onChange={(e) => void exec("set_clip_warp", { clipId: clip.id, autoTempo: true, mode: e.target.value })}>
          {STRETCH_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
    </div>
  );
}

function TakesTab({ clip }: { clip: Clip }) {
  const exec = useStore((s) => s.exec);
  const lanes = deriveTakeLanes(clip);
  return (
    <div className="v2-takes">
      {lanes.map((ln) => (
        <button key={ln.index} className={`v2-take${ln.isCurrent ? " on" : ""}`} title={ln.title}
          onClick={() => { if (!ln.isCurrent) void exec("set_current_take", { clipId: clip.id, takeIndex: ln.index }); }}>
          {ln.label}{ln.isCurrent && <span className="cur">●</span>}
        </button>
      ))}
      {lanes.some((l) => l.isCurrent) && (
        <button className="v2-btn" onClick={() => void exec("keep_take", { clipId: clip.id })}>Keep current take</button>
      )}
    </div>
  );
}
