// The instrument slot — a pinned, always-present row above the effects rack.
//
// This exists because the rack is FLAT: a synth was just another card with a small
// "inst" badge, inside a tab labelled FX. A producer looking for "where does my synth
// go" was being told to look under effects. An empty slot that says so is the fix —
// it is self-explaining in a way a missing card never is.

import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Plugin, Track } from "../../types";

/** The track's instrument, or null. Exported for the unit test. */
export function instrumentOf(track: Pick<Track, "plugins">): Plugin | null {
  return (track.plugins ?? []).find((p) => p.isInstrument) ?? null;
}

export function InstrumentSlot({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const openBrowserTab = useShell((s) => s.openBrowserTab);
  const inst = instrumentOf(track);
  // LOAD-BEARING: the picker loads onto store.selectedTrackId, not onto the track this
  // slot is displaying. Inspector.tsx shows a CLIP's track here (clipTrack ?? selectedTrack)
  // — select a clip on track B while track A is selected, and without this line the slot
  // would display B's instrument (Edit/✕ correctly target B, they pass track.id) while
  // pick() loads onto A. Same hazard, same fix, as the lane handler in TrackLaneList.tsx.
  const pick = () => { setSelectedTrack(track.id); openBrowserTab("plugins", "inst"); };

  if (!inst) {
    return (
      <div className="v2-instslot v2-instslot-empty" data-testid="v2-instrument-slot">
        <span className="v2-instslot-label">Instrument</span>
        <button className="btn v2-instslot-pick" data-testid="instslot-choose" onClick={pick}>
          No instrument — click to choose
        </button>
      </div>
    );
  }
  return (
    <div className="v2-instslot" data-testid="v2-instrument-slot">
      <span className="v2-instslot-label">Instrument</span>
      <span className="v2-instslot-name" data-testid="instslot-name">{inst.name}</span>
      <div className="v2-instslot-actions">
        <button className="btn" data-testid="instslot-edit"
          onClick={() => void exec("open_plugin_editor", { trackId: track.id, index: inst.index })}>Edit</button>
        <button className="btn" data-testid="instslot-swap" onClick={pick}>Swap</button>
        <button className="btn x" data-testid="instslot-remove"
          onClick={() => void exec("remove_plugin", { trackId: track.id, index: inst.index })}>✕</button>
      </div>
    </div>
  );
}
