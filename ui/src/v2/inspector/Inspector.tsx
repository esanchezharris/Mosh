// The contextual inspector — the single "door" to everything advanced (progressive
// disclosure). It tracks the selected track (always one, auto-selected) and, when a
// clip is selected, its clip context. Tabs appear only when they apply:
//   Mix · FX · Gen   (track)   + MIDI (midi clip) + Takes (clip with >1 take)
// FX and Generative REUSE the classic Dock's Rack + GenDrawer verbatim (same command
// seam) — only Mix/MIDI/Takes are small v2 surfaces. Deep editors (piano-roll, drum,
// automation) open as floating overlays from here.

import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useShell, type InspectorTab } from "../shellState";
import { Rack, GenDrawer } from "../../ui/Dock";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { LyricPanel } from "./LyricPanel";
import { deriveTakeLanes } from "../../ui/takeLanes";
import { useDrumWindow } from "../../ui/dock/useFloatingWindow";
import { midiInputOptions, currentTrackInput, trackOutputOptions, currentTrackOutput, trackOutputPatch } from "../../settings/routing";
import { meterAt, snapStep, tempoMapFrom } from "../../time";
import type { Clip, Track } from "../../types";

export function Inspector({ scope = "all" }: { scope?: "all" | "clip" | "track" }) {
  const snapshot = useStore((s) => s.snapshot);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedClipId = useShell((s) => s.selectedClipId);
  const tab = useShell((s) => s.inspectorTab);
  const setTab = useShell((s) => s.setInspectorTab);

  const selectedTrack = snapshot?.tracks.find((t) => t.id === selectedTrackId) ?? null;
  const clip = selectedClipId
    ? snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId)
    : undefined;
  // #55 (EDGECASE_SWEEP_V2_2026-07-18) — the editing CONTEXT follows the selected
  // clip's own track. Previously the header + Mix/FX/Gen named the track-selection
  // track while Clip/Warp edited a clip living on a DIFFERENT track — the header
  // lied about what the tabs operate on.
  const clipTrack = clip ? snapshot?.tracks.find((t) => t.clips.some((c) => c.id === clip.id)) ?? null : null;
  const track = clipTrack ?? selectedTrack;
  if (!track) return null;
  const isMidi = clip?.type === "midi";
  const isWave = clip?.type === "wave";
  const hasTakes = (clip?.numTakes ?? 0) > 1;

  const trackTabs: { id: InspectorTab; label: string }[] = [
    { id: "mix", label: "Mix" },
    { id: "fx", label: "FX" },
    { id: "lyrics", label: "Lyrics" },
  ];
  const clipTabs: { id: InspectorTab; label: string }[] = [
    ...(clip ? [{ id: "clip" as const, label: "Clip" }] : []),
    ...(isMidi ? [{ id: "midi" as const, label: "MIDI" }] : []),
    ...(isWave ? [{ id: "warp" as const, label: "Warp" }] : []),
    ...(hasTakes ? [{ id: "takes" as const, label: "Takes" }] : []),
  ];
  const tabs = scope === "clip"
    ? clipTabs
    : scope === "track"
      ? trackTabs
      : [...trackTabs.slice(0, 2), { id: "gen" as const, label: "Gen" }, ...trackTabs.slice(2), ...clipTabs];
  const fallback: InspectorTab = scope === "clip" ? "clip" : "mix";
  const active = tabs.some((candidate) => candidate.id === tab) ? tab : fallback;

  if (scope === "clip" && !clip) {
    return (
      <section className="v2-card v2-inspector v2-inspector-empty" data-testid="v2-inspector">
        <div className="v2-card-head"><span>Clip</span></div>
        <div className="v2-insp-empty">Select a clip to inspect it.</div>
      </section>
    );
  }

  return (
    <section className="v2-card v2-inspector" data-testid="v2-inspector">
      <div className="v2-card-head"><span>Inspector · {track.name}</span></div>
      <div className="v2-insp-tabs" role="tablist" aria-label="Inspector tabs">
        {tabs.map((t) => (
          <button key={t.id} id={`v2-insp-tab-${t.id}`} role="tab" aria-selected={active === t.id} aria-controls="v2-insp-body" className={active === t.id ? "on" : ""}
            data-testid={`v2-insp-tab-${t.id}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="v2-insp-body" id="v2-insp-body" role="tabpanel" aria-labelledby={`v2-insp-tab-${active}`} data-testid="v2-insp-body">
        {active === "mix" && <MixTab track={track} />}
        {active === "fx" && <Rack track={track} onAddPlugin={() => useShell.getState().openBrowserTab("plugins")} />}
        {active === "gen" && <GenDrawer track={track} selectedClipId={selectedClipId ?? undefined} />}
        {active === "lyrics" && <LyricPanel track={track} />}
        {active === "clip" && clip && <ClipTab clip={clip} />}
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
      {/* TRK-RENAME — `rename_track` shipped with NO user-facing call site in either
          shell: the only references in ui/src were the agent catalog, a brain test
          fixture and the small-model allowlist, so the command was agent-only and a
          mouse-only user could never name a track. Same commit-on-blur idiom as the
          Clip tab's rename_clip field below; `key` re-syncs the uncontrolled input when
          the backend changes the name under us (agent rename, undo, project reload). */}
      <label className="v2-field">
        <span>Name</span>
        <input
          type="text"
          defaultValue={track.name}
          key={track.name}
          data-testid="v2-track-name"
          aria-label="Track name"
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== track.name) void exec("rename_track", { trackId: track.id, name: next });
            else e.target.value = track.name;   // empty/unchanged → snap back, never send a blank
          }}
        />
      </label>
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
      {track.isInstrument && <MidiInputField track={track} />}
      <InputMonitorField track={track} />
      <div className="v2-mix-btns">
        <button className={track.mute ? "on" : ""} aria-pressed={!!track.mute} onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>Mute</button>
        <button className={track.solo ? "on" : ""} aria-pressed={!!track.solo} onClick={() => void exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>Solo</button>
      </div>
      <SendsSection track={track} />
    </div>
  );
}

// UI-REACH — set_input_monitor (off/automatic/on) had no control anywhere: the
// snapshot already carried track.monitor (types.ts) and the command was agent-only.
// TWO things make this NOT a plain per-track toggle, both worth being honest about:
//  1. cmdSetInputMonitor (MoshOps.cpp) is NOT undoable — it calls setMonitorMode on the
//     shared te::InputDevice and saveProps(), a global engine/device preference, not an
//     Edit-tree write, so there is no undo transaction to ride (same posture as
//     set_metronome). The select's value can therefore drift from what the button last
//     asked for if something else changes the device's mode — it always reflects the
//     snapshot, never local state.
//  2. It is DEVICE-level: two tracks fed by the same physical input SHARE one monitor
//     mode, so choosing "On" here silently changes it for every other track on that
//     input too. The title says so rather than implying a per-track independent setting.
// `applied` comes back false when no input device instance currently targets this track
// (headless, or no interface) — a normal `!ok` failure would already surface via the
// store's global lastError banner, but this is `ok:true` with nothing actually applied,
// which that banner does not catch. Silently doing nothing would be worse than saying so.
function InputMonitorField({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const [warn, setWarn] = useState<string | null>(null);
  const mode = track.monitor ?? "automatic";
  const choose = async (next: string) => {
    setWarn(null);
    const r = await exec("set_input_monitor", { trackId: track.id, mode: next });
    const data = r.data as { applied?: boolean; reason?: string } | undefined;
    if (r.ok && data?.applied === false) setWarn(data.reason ?? "no matching input device");
  };
  return (
    <>
      <label className="v2-field">
        <span>Monitor</span>
        <select
          className="btn ghost"
          data-testid="v2-input-monitor"
          aria-label={`Input monitoring for ${track.name}`}
          title="Device-level: every track fed by the same input shares this setting, not just this one"
          value={mode}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="off">Off</option>
          <option value="automatic">Auto</option>
          <option value="on">On</option>
        </select>
      </label>
      {warn && <div className="v2-field-warn" data-testid="v2-input-monitor-warn" role="status">Not applied — {warn}</div>}
    </>
  );
}

// CTL-001 — per-instrument-track live MIDI-input picker. An instrument track (one
// hosting a synth) receives live MIDI from a controller; this surfaces the read-only
// list_midi_inputs enumeration and routes the choice through the existing
// set_track_input command (the deviceID-keyed "explicitly-chosen input", RTG-001 —
// which arm_track honours for MIDI). No new mutation command.
function MidiInputField({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const midiInputs = useStore((s) => s.midiInputs);
  const loadMidiInputs = useStore((s) => s.loadMidiInputs);
  useEffect(() => { void loadMidiInputs(); }, [loadMidiInputs]);
  const opts = midiInputOptions(midiInputs);
  return (
    <label className="v2-field">
      <span>MIDI in</span>
      <select className="btn ghost" data-testid="v2-midi-input"
        aria-label={`MIDI input for ${track.name}`} value={currentTrackInput(track)}
        onChange={(e) => void exec("set_track_input", { trackId: track.id, deviceID: e.target.value })}>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// Sends / returns — the per-track door to aux buses. Create a reverb/delay return
// bus, send this track to it, and ride the send level. Every mutation is a MoshOps
// command (create_bus / add_send / set_send_level / remove_send) — no UI-local state.
function SendsSection({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const buses = useStore((s) => s.snapshot?.buses) ?? [];
  const sends = track.sends ?? [];
  // create_bus lived here with no rename or remove beside it — an asymmetry, not a design.
  // Both are bus-GLOBAL while this panel is per-track, so they sit tight against the bus
  // name (its identity) rather than among the send controls to its right, and the delete
  // confirms: cmdRemoveBus deletes the return track AND sweeps the matching send off every
  // track in the project, which is not recoverable by re-adding the bus.
  const [renaming, setRenaming] = useState<{ bus: number; name: string } | null>(null);
  const [confirmBus, setConfirmBus] = useState<{ bus: number; name: string } | null>(null);

  const commitRename = async () => {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const name = r.name.trim();
    if (name) await exec("rename_bus", { bus: r.bus, name });
  };
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
            {renaming?.bus === b.bus ? (
              <input
                className="v2-bus-rename" data-testid={`v2-bus-rename-${b.bus}`} autoFocus
                aria-label={`Rename ${b.name} bus`} value={renaming.name}
                onChange={(e) => setRenaming({ bus: b.bus, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                  else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                }}
                onBlur={() => void commitRename()}
              />
            ) : (
              <span className="v2-send-name" data-testid={`v2-bus-name-${b.bus}`} title={`${b.name} — double-click to rename`}
                onDoubleClick={() => setRenaming({ bus: b.bus, name: b.name })}>{b.name}</span>
            )}
            <button className="v2-btn icon v2-bus-rm" data-testid={`v2-bus-remove-${b.bus}`}
              title={`Delete the ${b.name} bus`} aria-label={`Delete the ${b.name} bus`}
              onClick={() => setConfirmBus({ bus: b.bus, name: b.name })}>🗑</button>
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
      {confirmBus && (
        <ConfirmDialog
          title={`Delete the ${confirmBus.name} bus?`} testId="v2-bus-remove-confirm" danger
          confirmLabel="Delete bus"
          body={<>This removes the return track and takes the {confirmBus.name} send off <strong>every</strong> track in the project, not just this one. Adding the bus back won't restore those sends.</>}
          onConfirm={() => { const b = confirmBus.bus; setConfirmBus(null); void exec("remove_bus", { bus: b }); }}
          onCancel={() => setConfirmBus(null)}
        />
      )}
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
      <select className="btn ghost" aria-label={`Output for ${track.name}`} value={cur}
        onChange={(e) => void exec("set_track_output", trackOutputPatch(e.target.value, track.id))}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// G4b — fade curve names, index-aligned with te::AudioFadeCurve::Type
// (1=linear 2=convex 3=concave 4=sCurve, per clipToVar's fadeInType/fadeOutType).
const FADE_CURVES = ["linear", "convex", "concave", "sCurve"] as const;
const fadeCurveName = (type: number | undefined): (typeof FADE_CURVES)[number] => FADE_CURVES[(type ?? 1) - 1] ?? "linear";

// G4A — the clip-level Inspector tab: rename / mute / gain. These three commands
// (rename_clip / set_clip_mute / set_clip_gain) already existed as agent-only
// MoshOps commands; this is their first UI surface. Gain is wave-clip-only
// (set_clip_gain rejects non-audio clips backend-side) — mute + rename apply to
// every clip type.
// G4b — fade-in / fade-out sliders (+ curve picker), below gain. Also wave-clip-only
// (set_clip_fade rejects non-audio clips backend-side, same as gain); clamped to the
// clip's own length so the slider can never request more fade than the clip has room for.
function ClipTab({ clip }: { clip: Clip }) {
  const exec = useStore((s) => s.exec);
  const session = useStore((s) => s.snapshot?.session);
  const snapDivision = useStore((s) => s.snapDivision);
  const isWave = clip.type === "wave";
  const clampToLength = (v: number) => Math.max(0, Math.min(v, clip.length));
  // clip-ops wave — normalize's optional target dB. Local-only (not a command arg
  // until the button fires); defaults to 0 dB, the same default the backend uses
  // when targetDb is omitted.
  const [normalizeTargetDb, setNormalizeTargetDb] = useState(0);
  // FU-CLIP-NUDGE — fine-move THIS clip by one grid-division step (session/tempo-
  // aware), independent of the drag-time snap toggle. Applies to every clip type
  // (move_clip isn't wave-only), so it sits outside the isWave-gated fields below.
  // Clamped so the clip can never nudge to a negative start.
  const nudge = (dir: 1 | -1) => {
    const step = snapStep(meterAt(tempoMapFrom(session), clip.start), snapDivision);
    void exec("move_clip", { clipId: clip.id, start: Math.max(0, clip.start + dir * step) });
  };
  return (
    <div className="v2-mix" data-testid="v2-clip-tab">
      <label className="v2-field">
        <span>Name</span>
        <input
          type="text"
          defaultValue={clip.name}
          key={clip.name}
          data-testid="v2-clip-name"
          onBlur={(e) => {
            if (e.target.value !== clip.name) void exec("rename_clip", { clipId: clip.id, name: e.target.value });
          }}
        />
      </label>
      <div className="v2-mix-btns" data-testid="v2-clip-nudge">
        <button className="btn" data-testid="v2-clip-nudge-left" title="Nudge left one grid division"
          onClick={() => nudge(-1)}>◂ Nudge</button>
        <button className="btn" data-testid="v2-clip-nudge-right" title="Nudge right one grid division"
          onClick={() => nudge(1)}>Nudge ▸</button>
      </div>
      {isWave && (
        <label className="v2-field">
          <span>Gain</span>
          <input
            type="range"
            min={-48}
            max={24}
            step={0.5}
            value={clip.gainDb ?? 0}
            data-testid="v2-clip-gain"
            onChange={(e) => void exec("set_clip_gain", { clipId: clip.id, gainDb: Number(e.target.value) })}
          />
          <span className="v2-val">{(clip.gainDb ?? 0).toFixed(1)}</span>
        </label>
      )}
      {isWave && (
        <label className="v2-field">
          <span>Fade in</span>
          <input
            type="range"
            min={0}
            max={clip.length}
            step={0.01}
            value={clampToLength(clip.fadeInSec ?? 0)}
            data-testid="v2-clip-fadein"
            onChange={(e) => void exec("set_clip_fade", { clipId: clip.id, fadeInSec: Number(e.target.value) })}
          />
          <span className="v2-val">{(clip.fadeInSec ?? 0).toFixed(2)}s</span>
          <select
            className="btn ghost"
            aria-label="Fade in curve"
            data-testid="v2-clip-fadein-curve"
            value={fadeCurveName(clip.fadeInType)}
            onChange={(e) => void exec("set_clip_fade", { clipId: clip.id, curveIn: e.target.value })}
          >
            {FADE_CURVES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}
      {isWave && (
        <label className="v2-field">
          <span>Fade out</span>
          <input
            type="range"
            min={0}
            max={clip.length}
            step={0.01}
            value={clampToLength(clip.fadeOutSec ?? 0)}
            data-testid="v2-clip-fadeout"
            onChange={(e) => void exec("set_clip_fade", { clipId: clip.id, fadeOutSec: Number(e.target.value) })}
          />
          <span className="v2-val">{(clip.fadeOutSec ?? 0).toFixed(2)}s</span>
          <select
            className="btn ghost"
            aria-label="Fade out curve"
            data-testid="v2-clip-fadeout-curve"
            value={fadeCurveName(clip.fadeOutType)}
            onChange={(e) => void exec("set_clip_fade", { clipId: clip.id, curveOut: e.target.value })}
          >
            {FADE_CURVES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}
      {isWave && (
        // clip-ops wave — reverse / auto-crossfade toggles + normalize. Wave-clip-only
        // (set_clip_reverse/set_clip_crossfade/normalize_clip all reject non-audio
        // clips backend-side, same as gain/fades above). Auto-crossfade is only
        // audible where this clip overlaps a neighbor on the same track.
        <div className="v2-mix-btns">
          <button
            className={clip.reversed ? "on" : ""}
            aria-pressed={!!clip.reversed}
            data-testid="v2-clip-reverse"
            onClick={() => void exec("set_clip_reverse", { clipId: clip.id, reversed: !clip.reversed })}
          >
            Reverse
          </button>
          <button
            className={clip.autoCrossfade ? "on" : ""}
            aria-pressed={!!clip.autoCrossfade}
            data-testid="v2-clip-crossfade"
            title="Only audible where this clip overlaps a neighbor on the same track"
            onClick={() => void exec("set_clip_crossfade", { clipId: clip.id, enabled: !clip.autoCrossfade })}
          >
            Auto-crossfade
          </button>
          <button
            className={clip.loopEnabled ? "on" : ""}
            aria-pressed={!!clip.loopEnabled}
            data-testid="v2-clip-loop"
            title="Loop a region of this clip's source"
            onClick={() => void exec("set_clip_loop", { clipId: clip.id, enabled: !clip.loopEnabled })}
          >
            Loop
          </button>
        </div>
      )}
      {isWave && clip.loopEnabled && (
        // Progressive disclosure: the loop region only appears once looping is ON
        // (mirrors the WarpTab's detect/fit helpers). Enabling with no bounds loops
        // the clip's whole length from 0 — these two fields then narrow it.
        <label className="v2-field">
          <span>Loop region</span>
          <input
            type="number"
            min={0}
            step={0.1}
            aria-label="Loop start (seconds)"
            data-testid="v2-clip-loop-start"
            value={Number((clip.loopStart ?? 0).toFixed(3))}
            onChange={(e) => void exec("set_clip_loop", { clipId: clip.id, enabled: true, start: Number(e.target.value) })}
          />
          <span className="v2-val">→</span>
          <input
            type="number"
            min={0}
            step={0.1}
            aria-label="Loop length (seconds)"
            data-testid="v2-clip-loop-length"
            value={Number((clip.loopLength ?? 0).toFixed(3))}
            onChange={(e) => void exec("set_clip_loop", { clipId: clip.id, enabled: true, length: Number(e.target.value) })}
          />
          <span className="v2-val">s</span>
        </label>
      )}
      {isWave && (
        <label className="v2-field">
          <span>Normalize to</span>
          <input
            type="number"
            step={0.5}
            value={normalizeTargetDb}
            data-testid="v2-clip-normalize-target"
            onChange={(e) => setNormalizeTargetDb(Number(e.target.value))}
          />
          <span className="v2-val">dB</span>
          <button
            className="btn"
            data-testid="v2-clip-normalize"
            onClick={() => void exec("normalize_clip", { clipId: clip.id, targetDb: normalizeTargetDb })}
          >
            Normalize
          </button>
        </label>
      )}
      <div className="v2-mix-btns">
        <button
          className={clip.mute ? "on" : ""}
          aria-pressed={!!clip.mute}
          data-testid="v2-clip-mute"
          onClick={() => void exec("set_clip_mute", { clipId: clip.id, mute: !clip.mute })}
        >
          Mute clip
        </button>
      </div>
    </div>
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
  // Detected-BPM readout (on demand — never auto-run; detection reads the whole source).
  const [detected, setDetected] = useState<{ bpm: number; confidence: number } | null>(null);
  const detect = async () => {
    const r = (await exec("detect_clip_bpm", { clipId: clip.id })) as
      { ok?: boolean; data?: { bpm?: number; confidence?: number } } | null;
    if (r?.ok && typeof r.data?.bpm === "number")
      setDetected({ bpm: r.data.bpm, confidence: r.data.confidence ?? 0 });
  };
  return (
    <div className="v2-mix v2-warp">
      <div className="v2-mix-btns">
        {/* Enabling warp auto-detects the loop's BPM and locks it to the grid. */}
        <button className={on ? "on" : ""} aria-pressed={on} data-testid="v2-warp-toggle"
          onClick={() => void exec("set_clip_warp", { clipId: clip.id, autoTempo: !on, detect: !on })}>Warp</button>
      </div>
      <label className="v2-field">
        <span>Stretch</span>
        <select className="btn ghost" aria-label="Stretch mode" data-testid="v2-warp-mode" value={mode} disabled={!on}
          onChange={(e) => void exec("set_clip_warp", { clipId: clip.id, autoTempo: true, mode: e.target.value })}>
          {STRETCH_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      {/* Progressive disclosure — the "easy warp" helpers appear only once warp is on. */}
      {on && (
        <>
          {typeof clip.sourceBpm === "number" && (
            <div className="v2-warp-bpm" data-testid="v2-warp-bpm">Source ≈ {clip.sourceBpm.toFixed(1)} BPM</div>
          )}
          <div className="v2-mix-btns v2-warp-fit">
            <button data-testid="v2-warp-detect" onClick={() => void detect()}>Detect BPM</button>
            {[1, 2, 4, 8].map((b) => (
              <button key={b} data-testid={`v2-warp-fit-${b}`} title={`Stretch to fill ${b} bar${b > 1 ? "s" : ""}`}
                onClick={() => void exec("stretch_clip", { clipId: clip.id, bars: b })}>Fit {b}</button>
            ))}
            <button data-testid="v2-warp-half" title="Halve the clip length (double-time)"
              onClick={() => void exec("stretch_clip", { clipId: clip.id, length: clip.length / 2 })}>½×</button>
            <button data-testid="v2-warp-double" title="Double the clip length (half-time)"
              onClick={() => void exec("stretch_clip", { clipId: clip.id, length: clip.length * 2 })}>2×</button>
          </div>
          {detected && (
            <div className="v2-warp-detected" data-testid="v2-warp-detected">
              Detected {detected.bpm.toFixed(1)} BPM ({Math.round(detected.confidence * 100)}%)
              <button className="btn" data-testid="v2-warp-apply"
                onClick={() => void exec("set_clip_warp", { clipId: clip.id, autoTempo: true, sourceBpm: detected.bpm })}>Apply</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TakesTab({ clip }: { clip: Clip }) {
  const exec = useStore((s) => s.exec);
  const lanes = deriveTakeLanes(clip);
  return (
    <div className="v2-takes">
      {lanes.map((ln) => (
        <button key={ln.index} className={`v2-take${ln.isCurrent ? " on" : ""}`} title={ln.title} aria-pressed={ln.isCurrent}
          onClick={() => { if (!ln.isCurrent) void exec("set_current_take", { clipId: clip.id, takeIndex: ln.index }); }}>
          {ln.label}{ln.isCurrent && <span className="cur" aria-hidden="true">●</span>}
        </button>
      ))}
      {lanes.some((l) => l.isCurrent) && (
        <button className="v2-btn" onClick={() => void exec("keep_take", { clipId: clip.id })}>Keep current take</button>
      )}
    </div>
  );
}
