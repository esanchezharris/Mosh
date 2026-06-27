// The contextual inspector — the single "door" to everything advanced (progressive
// disclosure). It tracks the selected track (always one, auto-selected) and, when a
// clip is selected, its clip context. Tabs appear only when they apply:
//   Mix · FX · Gen   (track)   + MIDI (midi clip) + Takes (clip with >1 take)
// FX and Generative REUSE the classic Dock's Rack + GenDrawer verbatim (same command
// seam) — only Mix/MIDI/Takes are small v2 surfaces. Deep editors (piano-roll, drum,
// automation) open as floating overlays from here.

import { useStore } from "../../store";
import { useShell, type InspectorTab } from "../shellState";
import { Rack, GenDrawer } from "../../ui/Dock";
import { LyricPanel } from "./LyricPanel";
import { deriveTakeLanes } from "../../ui/takeLanes";
import { useDrumWindow } from "../../ui/dock/useFloatingWindow";
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
  const hasTakes = (clip?.numTakes ?? 0) > 1;

  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "mix", label: "Mix" },
    { id: "fx", label: "FX" },
    { id: "gen", label: "Gen" },
    { id: "lyrics", label: "Lyrics" },
    ...(isMidi ? [{ id: "midi" as const, label: "MIDI" }] : []),
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
      <div className="v2-mix-btns">
        <button className={track.mute ? "on" : ""} aria-pressed={!!track.mute} onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>Mute</button>
        <button className={track.solo ? "on" : ""} aria-pressed={!!track.solo} onClick={() => void exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>Solo</button>
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
