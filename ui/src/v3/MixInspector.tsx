import { useStore } from "../store";
import { GenDrawer } from "../ui/GenDrawer";
import { midiInputOptions, trackOutputOptions, currentTrackOutput, trackOutputPatch, waveInputOptions, currentTrackInput } from "../settings/routing";
import type { Plugin, Snapshot } from "../types";
import { useV3 } from "./shellState";

function Fader({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  display: string; onChange: (n: number) => void;
}) {
  return (
    <label className="fader">
      <span className="nm">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="v">{display}</span>
    </label>
  );
}

function PluginRow({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const native = !!plugin.builtin && !plugin.external;
  return (
    <div className="pr" data-testid="v3-plugin" data-plugin-index={plugin.index}>
      <div className="hdr">
        <span className="nm">{plugin.name}</span>
        <span className={`kind${native ? " nat" : " vst"}`}>{native ? "MOSH" : (plugin.type || "VST3")}</span>
        <button type="button" className="btn ghost sm" aria-label={plugin.enabled ? "Bypass" : "Enable"}
          onClick={() => void exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })}>
          {plugin.enabled ? "on" : "off"}
        </button>
      </div>
      {native && plugin.params.slice(0, 4).map((p) => (
        <label className="fader" key={p.index}>
          <span className="nm">{p.name}</span>
          <input type="range" min={0} max={1} step={0.01} value={p.value}
            onChange={(e) => void exec("set_plugin_param", { trackId, index: plugin.index, paramIndex: p.index, value: Number(e.target.value) })} />
          <span className="v">{p.value.toFixed(2)}</span>
        </label>
      ))}
      {!native && (
        <button type="button" className="btn pri" data-testid="v3-open-editor"
          onClick={() => void exec("open_plugin_editor", { trackId, index: plugin.index })}>
          Open Editor
        </button>
      )}
    </div>
  );
}

export function MixInspector({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedClipId = useV3((s) => s.selectedClipId);
  const loadRouting = useStore((s) => s.loadRouting);
  const loadMidiInputs = useStore((s) => s.loadMidiInputs);
  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? snapshot.tracks[0];
  const waveInputs = useStore((s) => s.waveInputs);
  const midiInputs = useStore((s) => s.midiInputs);
  const trackOutputs = useStore((s) => s.trackOutputs);
  const buses = snapshot.buses ?? [];

  if (!track) {
    return <aside className="insp" data-testid="v3-inspector"><div className="ibody">Select a track</div></aside>;
  }

  const vol = track.volumeDb ?? 0;
  const pan = track.pan ?? 0;
  const panLabel = pan === 0 ? "C" : pan < 0 ? `L ${Math.round(-pan * 100)}` : `R ${Math.round(pan * 100)}`;
  const plugins = (track.plugins ?? []).filter((p) => p.external || p.builtin || p.rave);
  const outs = trackOutputOptions(trackOutputs, track.id);
  const outVal = currentTrackOutput(track);
  const ins = track.isInstrument ? midiInputOptions(midiInputs) : waveInputOptions(waveInputs);

  return (
    <aside className="insp" data-testid="v3-inspector" data-track-id={track.id}>
      <div className="ibody">
        <details className="grp" open>
          <summary className="grphd"><span className="sec">Levels</span></summary>
          <div className="grp-body">
            <Fader label="Vol" value={vol} min={-60} max={6} step={0.5} display={`${vol.toFixed(1)} dB`}
              onChange={(db) => void exec("set_track_volume", { trackId: track.id, db })} />
            <Fader label="Pan" value={pan} min={-1} max={1} step={0.02} display={panLabel}
              onChange={(p) => void exec("set_track_pan", { trackId: track.id, pan: p })} />
            <label className="fader">
              <span className="nm">Out</span>
              <select aria-label="Output" value={outVal}
                onFocus={() => void loadRouting()}
                onChange={(e) => void exec("set_track_output", trackOutputPatch(e.target.value, track.id))}>
                {outs.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {ins.length > 0 && (
              <label className="fader">
                <span className="nm">In</span>
                <select aria-label="Input" value={currentTrackInput(track)}
                  onFocus={() => { void loadRouting(); void loadMidiInputs(); }}
                  onChange={(e) => void exec("set_track_input", { trackId: track.id, deviceID: e.target.value })}>
                  {ins.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            )}
          </div>
        </details>

        <details className="grp" open>
          <summary className="grphd"><span className="sec">Generative</span></summary>
          <div className="grp-body v3-gen">
            <GenDrawer track={track} selectedClipId={selectedClipId ?? undefined} />
          </div>
        </details>

        <details className="grp quiet" open>
          <summary className="grphd"><span className="sec">Sends</span></summary>
          <div className="grp-body" data-testid="v3-sends">
            {buses.length === 0 && <div className="set-hint">No buses yet</div>}
            {buses.map((b) => {
              if (b.trackId === track.id) return null;
              const send = (track.sends ?? []).find((s) => s.bus === b.bus);
              return (
                <div key={b.bus} className="send">
                  <span className="nm">{b.name}</span>
                  {send ? (
                    <>
                      <input type="range" min={-60} max={6} step={0.5} value={send.db}
                        aria-label={`${b.name} send`}
                        onChange={(e) => void exec("set_send_level", { trackId: track.id, bus: b.bus, db: Number(e.target.value) })} />
                      <span className="v">{send.db.toFixed(0)}</span>
                    </>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => void exec("add_send", { trackId: track.id, bus: b.bus, db: 0 })}>Add</button>
                  )}
                </div>
              );
            })}
            <button type="button" className="btn sm" onClick={() => void exec("create_bus", {})}>+ Bus</button>
          </div>
        </details>

        <details className="grp quiet" open>
          <summary className="grphd"><span className="sec">Plugins</span></summary>
          <div className="grp-body chain" data-testid="v3-plugins">
            {plugins.map((p) => <PluginRow key={p.index} plugin={p} trackId={track.id} />)}
            <button type="button" className="pr add" data-testid="v3-add-plugin"
              onClick={() => useV3.getState().setPane("plugins")}>+ Add plugin</button>
          </div>
        </details>
      </div>
    </aside>
  );
}

export function inspectorHasForbiddenTabs(host: ParentNode): boolean {
  const text = host.textContent ?? "";
  return /\bFX\b/.test(text) && /\bLyrics\b/.test(text) && host.querySelector('[role="tablist"]') != null;
}
