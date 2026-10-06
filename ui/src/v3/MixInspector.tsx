import { useEffect, useState, type DragEvent } from "react";
import { useStore } from "../store";
import { ReImagineSection } from "./ReImagineSection";
import { midiInputOptions, trackOutputOptions, currentTrackOutput, trackOutputPatch, waveInputOptions, currentTrackInput } from "../settings/routing";
import type { Plugin, Snapshot, Track } from "../types";
import { PresetPicker } from "../ui/PresetPicker";
import { Range } from "./Range";
import { useV3 } from "./shellState";
import { usePresetMemory } from "./presetMemory";
import { pluginHint, showsEveryParam } from "./pluginParams";
import { PANELS } from "./panels/registry";
import { GenericParams, genericSummary } from "./panels/GenericParams";
import { panelKey, usePanelState } from "./panels/panelState";
import type { PanelProps } from "./panels/types";

function Fader({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  display: string; onChange: (n: number) => void;
}) {
  return (
    <label className="fader">
      <span className="nm">{label}</span>
      <Range min={min} max={max} step={step} value={value}
        aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="v" data-testid={`v3-fader-${label.toLowerCase()}`}>{display}</span>
    </label>
  );
}

// ── drag a plugin above or below another to reorder the chain ───────────────
// Signal-chain order is audible (a tuner ahead of a compressor is a different sound from
// one behind it), so it gets a gesture. The HEADER is the handle: making the whole card
// draggable would let a drag start on a parameter slider. The drop lands above or below
// the row under the pointer, whichever half it is over, and a line shows where.
// The drag source lives here rather than in the DataTransfer payload: the drag never
// leaves the page, and WebKit hides custom payload types while the drag is in flight.
let draggingPlugin: { trackId: string; index: number } | null = null;

export type PluginDropSide = "above" | "below";

/** Where a dragged plugin lands, as reorder_plugin's `toIndex` (the index it ends up at
 *  once it has been taken out of its old slot). Null when the drop changes nothing. */
export function pluginDropIndex(from: number, target: number, side: PluginDropSide): number | null {
  if (from === target) return null;
  const to = side === "above" ? (from < target ? target - 1 : target)
                              : (from < target ? target : target + 1);
  return to === from ? null : to;
}

function PluginRow({ plugin, trackId, sampleRate, prevIndex, nextIndex }: {
  plugin: Plugin; trackId: string;
  /** The session's sample rate, for curves that depend on it. */
  sampleRate: number;
  /** The chain indices of the visible plugins above and below, for the keyboard move. */
  prevIndex?: number; nextIndex?: number;
}) {
  const exec = useStore((s) => s.exec);
  const native = !!plugin.builtin && !plugin.external;
  const def = native ? PANELS[plugin.type] : undefined;
  // Minimized is this viewer's view preference: never a command, never undoable.
  const key = panelKey(trackId, plugin);
  const collapsed = usePanelState((s) => !!s.collapsed[key]);
  const toggle = usePanelState((s) => s.toggle);
  const [dropSide, setDropSide] = useState<PluginDropSide | null>(null);
  const acceptsDrag = () => draggingPlugin !== null && draggingPlugin.trackId === trackId;
  const sideUnder = (e: DragEvent<HTMLDivElement>): PluginDropSide => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2 ? "above" : "below";
  };
  const moveTo = (toIndex: number | undefined) => {
    if (toIndex !== undefined) void exec("reorder_plugin", { trackId, index: plugin.index, toIndex });
  };
  // Every change a panel makes goes through these two. A gesture id groups one drag into
  // one undo step (the engine coalesces calls that share it).
  const setParam: PanelProps["setParam"] = (paramIndex, value, opts) =>
    void exec("set_plugin_param", { trackId, index: plugin.index, paramIndex, value, ...(opts?.gesture ? { gesture: opts.gesture } : {}) });
  const setState: PanelProps["setState"] = (stateKey, value, opts) =>
    void exec("set_plugin_state", { trackId, index: plugin.index, key: stateKey, value, ...(opts?.gesture ? { gesture: opts.gesture } : {}) });
  const panelProps: PanelProps = { plugin, trackId, sampleRate, setParam, setState };
  const hint = native && !def ? pluginHint(plugin) : null;
  const summary = def ? def.summary(plugin) : genericSummary(plugin);
  const Mini = def?.Mini;
  return (
    <div className="pr" data-testid="v3-plugin" data-plugin-index={plugin.index}
      data-plugin-type={plugin.type}
      data-preset={plugin.preset ? plugin.preset.id : undefined}
      data-units={native && showsEveryParam(plugin) ? "" : undefined}
      data-drop={dropSide ?? undefined}
      data-collapsed={collapsed ? "" : undefined}
      onDragOver={(e) => {
        if (!acceptsDrag()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropSide(draggingPlugin!.index === plugin.index ? null : sideUnder(e));
      }}
      onDragLeave={(e) => {
        // Crossing onto a child fires dragleave too; only leaving the row clears the line.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropSide(null);
      }}
      onDrop={(e) => {
        if (!acceptsDrag()) return;
        e.preventDefault();
        const from = draggingPlugin!.index;
        const toIndex = pluginDropIndex(from, plugin.index, sideUnder(e));
        draggingPlugin = null;
        setDropSide(null);
        if (toIndex !== null) void exec("reorder_plugin", { trackId, index: from, toIndex });
      }}>
      <div className="hdr" data-testid="v3-plugin-handle" draggable tabIndex={0}
        title="Drag to reorder (or Alt+Up / Alt+Down)"
        onDragStart={(e) => {
          draggingPlugin = { trackId, index: plugin.index };
          e.dataTransfer.setData("text/plain", plugin.name);   // a drag with no payload never starts
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => { draggingPlugin = null; setDropSide(null); }}
        onKeyDown={(e) => {
          // The keyboard path: a drag is not reachable without a pointer.
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          moveTo(e.key === "ArrowUp" ? prevIndex : nextIndex);
        }}>
        <button type="button" className="pp-chev" data-testid="v3-plugin-minimize" draggable={false}
          aria-expanded={!collapsed} aria-label={collapsed ? `Expand ${plugin.name}` : `Minimize ${plugin.name}`}
          title={collapsed ? "Expand" : "Minimize"}
          onClick={() => toggle(key)} onPointerDown={(e) => e.stopPropagation()}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2 L7 5 L3 8" /></svg>
        </button>
        <span className="nm">{plugin.name}</span>
        <span className={`kind${native ? " nat" : " vst"}`}>{native ? "MOSH" : (plugin.type || "VST3")}</span>
        <button type="button" className="btn ghost sm" aria-label={plugin.enabled ? "Bypass" : "Enable"}
          onClick={() => void exec("bypass_plugin", { trackId, index: plugin.index, bypassed: plugin.enabled })}>
          {plugin.enabled ? "on" : "off"}
        </button>
      </div>
      {collapsed ? (
        // Minimized: one line that still says what the plugin is doing (and, for the
        // plugins that have one, a tiny live element).
        <div className="pp-min" data-testid="v3-plugin-summary">
          {Mini && <Mini {...panelProps} />}
          <span className="sum">{summary}</span>
        </div>
      ) : (<>
      {/* Its own line, not a header chip: the header is one tight row and a preset name
          is long. It names where the plugin came from; editing a value does not remove it. */}
      {plugin.preset && (
        <div className="set-hint" data-testid="v3-plugin-preset"
          title="Inserted by this preset. Undo removes the whole preset in one step.">
          Preset: {plugin.preset.name}
        </div>
      )}
      {plugin.isInstrument && <PresetPicker plugin={plugin} trackId={trackId}
        onLoaded={(pr) => usePresetMemory.getState().remember(trackId, plugin.index, pr.name)} />}
      {/* A plugin with a panel of its own (panels/registry.ts) draws it; any other native
          plugin keeps the plain list of controls. */}
      {def ? <def.Panel {...panelProps} /> : native && <GenericParams plugin={plugin} setParam={setParam} />}
      {hint && <div className="set-hint" data-testid="v3-plugin-hint">{hint}</div>}
      {!native && (
        <button type="button" className="btn pri" data-testid="v3-open-editor"
          onClick={() => void exec("open_plugin_editor", { trackId, index: plugin.index })}>
          Open Editor
        </button>
      )}
      </>)}
    </div>
  );
}

/** Can a vocal-chain preset go on this track? Mirrors the engine's own preflight
 *  (cmdApplyTrackPreset), which stays the authority — this only decides whether to offer. */
export function acceptsTrackPreset(track: Track): boolean {
  return (track.type ?? "audio") === "audio" && !track.isInstrument && !track.isReturn
    && !track.isGroup && !track.frozen
    && !(track.plugins ?? []).some((p) => p.isInstrument);
}

// The manual entry point for track-chain presets ("Mosh Clean Lead v0"): one pick applies
// the whole chain to THIS track as one undo step (apply_track_preset). The track id is the
// one this picker was rendered for — never a fallback — and the engine re-validates it.
// Keyed by track at the call site, so a refusal shown for one track cannot linger under,
// or arrive late onto, another.
function TrackPresetPicker({ trackId, recording }: { trackId: string; recording: boolean }) {
  const exec = useStore((s) => s.exec);
  const [presets, setPresets] = useState<{ name: string; file: string }[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    void Promise.resolve(exec("list_presets", { plugin: "track-chain" })).then((r) => {
      if (dead || !r?.ok) return;
      setPresets((r.data as { presets?: { name: string; file: string }[] } | undefined)?.presets ?? []);
    });
    return () => { dead = true; };
  }, [exec]);
  if (!presets || presets.length === 0) return null;
  return (
    <>
      <select className="preset-pick" data-testid="v3-track-preset" value="" disabled={recording}
        aria-label="Apply a vocal preset to this track"
        title={recording ? "Stop recording to apply a preset" : "Adds the preset\u2019s effects to this track as one undo step"}
        onChange={(e) => {
          const file = e.target.value;
          if (!file) return;
          setFailed(null);
          void Promise.resolve(exec("apply_track_preset", { trackId, file })).then((r) => {
            if (r && !r.ok) setFailed(r.error ?? "Could not apply the preset");
          });
        }}>
        <option value="" disabled>{recording ? "Vocal preset (stop recording first)" : "Vocal preset\u2026"}</option>
        {presets.map((p) => <option key={p.file} value={p.file}>{trackPresetLabel(p.name)}</option>)}
      </select>
      {failed && <div className="set-hint" role="alert" data-testid="v3-track-preset-error">{failed}</div>}
    </>
  );
}

/** "mosh-clean-lead-v0" -> "Mosh Clean Lead v0": the library lists file stems. */
export function trackPresetLabel(fileStem: string): string {
  return fileStem.split("-").map((w) => (/^v\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

export function MixInspector({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
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

        <ReImagineSection snapshot={snapshot} />

        <details className="grp quiet" open>
          <summary className="grphd"><span className="sec">Sends</span></summary>
          <div className="grp-body" data-testid="v3-sends">
            {buses.length === 0 && <div className="set-hint">No buses yet</div>}
            {buses.map((b) => {
              if (b.trackId === track.id) return null;
              const send = (track.sends ?? []).find((s) => s.bus === b.bus);
              return (
                <div key={b.bus} className="send" data-testid="v3-send" data-bus={b.bus} data-send-db={send ? send.db : undefined}>
                  <span className="nm">{b.name}</span>
                  {send ? (
                    <>
                      <Range min={-60} max={6} step={0.5} value={send.db}
                        aria-label={`${b.name} send`}
                        onChange={(e) => void exec("set_send_level", { trackId: track.id, bus: b.bus, db: Number(e.target.value) })} />
                      <span className="v">{send.db.toFixed(0)}</span>
                    </>
                  ) : (
                    <button type="button" className="btn sm" data-testid="v3-send-add" onClick={() => void exec("add_send", { trackId: track.id, bus: b.bus, db: 0 })}>Add</button>
                  )}
                </div>
              );
            })}
            <button type="button" className="btn sm" data-testid="v3-add-bus" onClick={() => void exec("create_bus", {})}>+ Bus</button>
          </div>
        </details>

        <details className="grp quiet" open>
          <summary className="grphd"><span className="sec">Plugins</span></summary>
          <div className="grp-body chain" data-testid="v3-plugins">
            {plugins.map((p, i) => <PluginRow key={p.index} plugin={p} trackId={track.id}
              sampleRate={snapshot.session?.sampleRate || 48000}
              prevIndex={plugins[i - 1]?.index} nextIndex={plugins[i + 1]?.index} />)}
            <button type="button" className="pr add" data-testid="v3-add-plugin"
              onClick={() => useV3.getState().setPane("plugins")}>+ Add plugin</button>
            {/* Offered only for a track the producer actually SELECTED. The inspector
                falls back to the first track when nothing is selected; a preset must
                never ride that fallback onto a track nobody chose. */}
            {selectedTrackId === track.id && acceptsTrackPreset(track)
              && <TrackPresetPicker key={track.id} trackId={track.id} recording={!!snapshot.transport?.recording} />}
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
