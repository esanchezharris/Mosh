import { useEffect, useState } from "react";
import { useStore } from "../store";
import { SampleBrowser } from "../ui/SampleBrowser";
import { PresetPicker, presetKeyFor } from "../ui/PresetPicker";
import type { DirListing } from "../types";
import { useV3 } from "./shellState";
import { presetKey, usePresetMemory } from "./presetMemory";

function MidiBrowser() {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const snapshot = useStore((s) => s.snapshot);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Land onto the selected track when it can take MIDI (no wave audio on it); otherwise the
  // engine creates a MIDI track named after the file. One command, one undo step.
  const importFile = async (file: string) => {
    const track = snapshot?.tracks.find((t) => t.id === selectedTrackId);
    const onto = track && !track.clips.some((c) => c.type === "wave") ? track.id : undefined;
    const r = await exec("import_midi_file", onto ? { file, trackId: onto } : { file }) as { ok: boolean; data?: { trackId?: string; clipId?: string; noteCount?: number }; error?: string };
    if (!r.ok) { setMessage(r.error ?? "import failed"); return; }
    setMessage(null);
    const st = useStore.getState();
    if (r.data?.trackId) st.setSelectedTrack(r.data.trackId);
    if (r.data?.clipId) st.select([r.data.clipId]);
  };
  useEffect(() => {
    void exec("list_directory", {}).then((r) => {
      if (r.ok && r.data) setListing(r.data as DirListing);
    });
  }, [exec]);
  const midi = (listing?.entries ?? []).filter((e) => /\.(mid|midi)$/i.test(e.name));
  return (
    <div className="pane-list" data-testid="v3-midi-browser">
      {midi.length === 0 && <div className="set-hint" style={{ padding: 10 }}>No MIDI files in this folder.</div>}
      {midi.map((e) => (
        <button key={e.path} type="button" className="br-row" data-testid="v3-midi-file" title="Import as a MIDI clip"
          onClick={() => void importFile(e.path)}>{e.name}</button>
      ))}
      {message && <div className="set-hint" role="status" style={{ padding: 10 }}>{message}</div>}
    </div>
  );
}

// Presets for the SELECTED track's instruments, through the same list_presets / load_preset seam
// the inspector rows and the Rack use. Not an FX-preset library: an instrument with no
// loadable format (Serum, the drum sampler) is named, not offered a picker that cannot work.
function PresetsPane() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const track = snapshot?.tracks.find((t) => t.id === selectedTrackId) ?? snapshot?.tracks[0];
  const instruments = (track?.plugins ?? []).filter((p) => p.isInstrument);
  const loaded = usePresetMemory((s) => s.byKey);
  const remember = usePresetMemory((s) => s.remember);
  return (
    <div className="pane-list" data-testid="v3-presets">
      {!track && <div className="set-hint" style={{ padding: 10 }}>Select a track.</div>}
      {track && instruments.length === 0 && (
        <div className="set-hint" style={{ padding: 10 }}>{track.name} has no instrument. Add 4OSC from Plugins to get presets.</div>
      )}
      {track && instruments.map((p) => (
        <div key={p.index} className="br-row preset-row" data-testid="v3-preset-row">
          <span className="preset-id">
            <span className="nm">{p.name}</span>
            {loaded[presetKey(track.id, p.index)] && (
              <span className="preset-now" data-testid="v3-preset-current" title="The preset loaded on this instrument">
                {loaded[presetKey(track.id, p.index)]}
              </span>
            )}
          </span>
          {presetKeyFor(p)
            ? <PresetPicker plugin={p} trackId={track.id} onLoaded={(pr) => remember(track.id, p.index, pr.name)} />
            : <span className="set-hint">no loadable presets</span>}
        </div>
      ))}
    </div>
  );
}

export function BrowserPane() {
  const tab = useV3((s) => s.browserTab);
  const setTab = useV3((s) => s.setBrowserTab);
  return (
    <aside className="side-pane" data-testid="v3-browser">
      <div className="pane-hd">
        <span className="sec">Browser</span>
        <span className="pane-tabs">
          <button type="button" className={tab === "files" ? "on" : ""} data-testid="v3-browser-files" onClick={() => setTab("files")}>Files</button>
          <button type="button" className={tab === "midi" ? "on" : ""} data-testid="v3-browser-midi" onClick={() => setTab("midi")}>MIDI</button>
          <button type="button" className={tab === "presets" ? "on" : ""} data-testid="v3-browser-presets" onClick={() => setTab("presets")}>Presets</button>
        </span>
      </div>
      {tab === "files" && <div className="pane-list"><SampleBrowser hidePaths /></div>}
      {tab === "midi" && <MidiBrowser />}
      {tab === "presets" && <PresetsPane />}
    </aside>
  );
}
