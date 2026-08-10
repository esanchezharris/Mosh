// The Settings panel — RENDERS ITSELF from the schema. One renderer per setting
// `type`; add a descriptor to schema.ts and it appears here automatically, grouped
// by category. Templates (preset bundles) sit at the top; the user can pick one and
// then override any individual setting on top (template + diffs).
//
// Two intentional exceptions to "schema-driven + local":
//   • Engine (buffer / threads / sample rate / device) — backend state from the
//     snapshot, mutated through its EXISTING MoshOps commands. Not in the schema.
//   • Project (new/save/open/recent) — existing file-management actions, kept as-is.
// Everything else is UI-local and persisted to localStorage via useSettings.

import { useEffect } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile, brainChat } from "../bridge";
import type { Snapshot } from "../types";
import { useSettings } from "./store";
import { settingsByCategory, type SettingDef } from "./schema";
import { TEMPLATES } from "./templates";
import { eventToCombo } from "../interaction/keymap";
import { effectiveInteractionSetting } from "../interaction/config";
import { activeShell, isV2Active } from "../v2/shellFlag";
import { settingHiddenForShell } from "./shellVisibility";
import { runAction, FILE_MENU, type ActionId } from "../menuActions";
import {
  outputDeviceOptions,
  inputDeviceOptions,
  waveInputOptions,
  currentTrackInput,
  audioDevicePatch,
} from "./routing";

// ── one renderer per setting type ───────────────────────────────────────────
function SettingControl({ def }: { def: SettingDef }) {
  const raw = useSettings((s) => s.values[def.id]);
  const set = useSettings((s) => s.set);
  // keymap/gestureTable resolve through the live shell's default bundle
  // (effectiveInteractionSetting): with no override persisted, an unset control
  // must SHOW the value the app is actually using — displaying "mosh" while the
  // live shell resolves ableton was exactly the confusion that hid this bug.
  const value = raw !== undefined ? raw
    : def.id === "keymap" || def.id === "gestureTable"
      ? effectiveInteractionSetting(def.id)
      : def.default;

  switch (def.type) {
    case "enum":
      return (
        <select
          value={String(value)}
          aria-label={def.label}
          onChange={(e) => set(def.id, e.target.value)}
        >
          {(def.constraints?.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );

    case "bool":
      return (
        <button
          className={`btn${value ? " on" : ""}`}
          role="switch"
          aria-checked={Boolean(value)}
          aria-label={def.label}
          onClick={() => set(def.id, !value)}
        >
          {value ? "On" : "Off"}
        </button>
      );

    case "number": {
      const { min, max, step } = def.constraints ?? {};
      const num = Number(value);
      return (
        <span className="set-num">
          <input
            type="range"
            min={min ?? 0}
            max={max ?? 1}
            step={step ?? 0.01}
            value={num}
            aria-label={def.label}
            onChange={(e) => set(def.id, Number(e.target.value))}
          />
          <span className="tc set-num-val">{Math.round(num * 100) / 100}</span>
        </span>
      );
    }

    case "key":
      return (
        <button
          className="btn tc"
          aria-label={def.label}
          title="Click to rebind · right-click to clear"
          onContextMenu={(e) => { e.preventDefault(); set(def.id, ""); }} // clear → inherit preset
          onClick={(e) => {
            const btn = e.currentTarget;
            const onKey = (ev: KeyboardEvent) => {
              // Swallow the capture keypress completely so it can't ALSO fire its live
              // action (the global Arrange keydown listener is on window — without this,
              // rebinding to e.g. Mod+Z would also undo).
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              const combo = eventToCombo(ev);
              if (!combo) return; // lone modifier — keep waiting for the real key
              set(def.id, combo); // store the canonical combo (e.g. "Mod+P")
              window.removeEventListener("keydown", onKey, true);
              btn.classList.remove("on");
            };
            btn.classList.add("on");
            window.addEventListener("keydown", onKey, true);
          }}
        >
          {String(value) || "—"}
        </button>
      );

    case "gesture-table":
    default:
      // Editable gesture/keymap tables are a later phase (templates already reserve
      // the slot); render the current value read-only so nothing crashes if one is added.
      return <span className="pop-note tc">{String(value)} · editor coming soon</span>;
  }
}

function SettingRow({ def }: { def: SettingDef }) {
  return (
    <label className="pop-row" title={def.help}>
      <span>{def.label}</span>
      <SettingControl def={def} />
    </label>
  );
}

// ── template picker (preset bundles) ────────────────────────────────────────
function TemplatePicker() {
  const active = useSettings((s) => s.template);
  const applyTemplate = useSettings((s) => s.applyTemplate);
  const reset = useSettings((s) => s.reset);
  return (
    <div className="pop-group">
      <div className="pop-label">Template</div>
      <div className="pop-actions" data-testid="template-picker">
        {TEMPLATES.map((t) => (
          <button
            key={t.name}
            className={`btn${active === t.name ? " on" : ""}`}
            aria-pressed={active === t.name}
            onClick={() => applyTemplate(t.name)}
          >
            {t.label}
          </button>
        ))}
        <button className="btn" title="Restore default settings" onClick={() => reset()}>Reset</button>
      </div>
      <div className="pop-note">A starting point — override any setting on top.</div>
    </div>
  );
}

// ── backend-owned Engine block — wired to its EXISTING MoshOps commands ──────
// (Named export: the no-device recovery pickers are component-tested directly.)
export function EngineSettings({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const audioDevices = useStore((s) => s.audioDevices);
  const loadAudioDevices = useStore((s) => s.loadAudioDevices);
  // The Device row enumerates like AudioRouting does: CoreAudio lists regardless
  // of an open device, so the DEGRADED startup (saved interface unplugged) still
  // offers the switch — that is exactly when this row matters.
  useEffect(() => { void loadAudioDevices(); }, [loadAudioDevices]);
  const outs = outputDeviceOptions(audioDevices);
  const outVal = audioDevices?.current.outputDevice ?? "";
  const setOutput = async (value: string) => {
    await exec("set_audio_device", { outputDevice: value });
    await loadAudioDevices();
    await refresh();
  };
  const s = snapshot.session;
  return (
    <div className="pop-group">
      <div className="pop-label">Engine</div>
      <label className="pop-row"><span>Device</span>
        {outs.length > 0 ? (
          <select aria-label="Engine device" value={outVal}
                  onChange={(e) => void setOutput(e.target.value)}>
            {!outs.includes(outVal) && <option value="" disabled>Select output…</option>}
            {outs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        ) : (
          <span className="tc">{s.audioDeviceName ?? (s.audioEnabled ? "default" : "—")}</span>
        )}
      </label>
      <div className="pop-row"><span>Sample rate</span><span className="tc">{s.sampleRate} Hz</span></div>
      <label className="pop-row"><span>Buffer</span>
        <select value={String(s.bufferSize ?? 512)} onChange={(e) => void exec("set_buffer_size", { bufferSize: Number(e.target.value) }).then(() => refresh())}>
          {[128, 256, 512, 1024].map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </label>
      <label className="pop-row"><span>Threads</span>
        <select value={String(s.audioThreads ?? s.availableCores ?? 8)} onChange={(e) => void exec("set_audio_threads", { threads: Number(e.target.value) }).then(() => refresh())}>
          {Array.from({ length: s.availableCores ?? 8 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}{s.audioThreadsAuto && n === (s.audioThreads ?? n) ? " (auto)" : ""}</option>)}
        </select>
      </label>
    </div>
  );
}

// ── G3 — audio-device select + per-track input picker ───────────────────────
// All view data comes from the read-only enumerations (list_audio_devices via
// loadAudioDevices, list_wave_inputs via loadRouting); every change rides an
// EXISTING MoshOps command (set_audio_device / set_track_input) and re-fetches.
// No new mutation path, no audio concepts cross the seam — just option lists.
// (Named export: the no-device recovery pickers are component-tested directly.)
export function AudioRouting({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const audioDevices = useStore((s) => s.audioDevices);
  const waveInputs = useStore((s) => s.waveInputs);
  const loadAudioDevices = useStore((s) => s.loadAudioDevices);
  const loadRouting = useStore((s) => s.loadRouting);
  // Lazy-load both enumerations when Settings opens (no-op when not native).
  useEffect(() => { void loadAudioDevices(); void loadRouting(); }, [loadAudioDevices, loadRouting]);

  // Re-enumerate after a device switch (the available output/input lists are
  // type-dependent) and after an input change (a track's input field moves).
  const setDevice = async (field: "output" | "input", value: string) => {
    await exec("set_audio_device", audioDevicePatch(field, value));
    await loadAudioDevices();
    await refresh();
  };
  const setTrackInput = async (trackId: string, deviceID: string) => {
    await exec("set_track_input", { trackId, deviceID });
    await loadRouting();
    await refresh();
  };

  const outs = outputDeviceOptions(audioDevices);
  const ins = inputDeviceOptions(audioDevices);
  const inputOpts = waveInputOptions(waveInputs);
  // Group (submix) and return tracks have no hardware input — only real audio/drum
  // tracks can be armed from an input device.
  const tracks = snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn);
  // The pickers ride ENUMERATION, not an open device: the DEGRADED state (audio
  // requested but the open failed — engine enumerates CoreAudio regardless) is
  // exactly when the user needs to switch outputs. Only a session with NOTHING
  // enumerable (headless, no device types) gets the note. set_audio_device opens
  // the pick and recovers the session engine-side.
  const enumerable = outs.length > 0 || ins.length > 0;
  const degraded = audioDevices != null && !audioDevices.audioEnabled && enumerable;
  const outVal = audioDevices?.current.outputDevice ?? "";
  const inVal = audioDevices?.current.inputDevice ?? "";

  return (
    <div className="pop-group">
      <div className="pop-label">Audio routing</div>

      {audioDevices && !enumerable ? (
        <div className="pop-note">No audio device in this session.</div>
      ) : (
        <>
          {degraded && (
            <div className="pop-note" role="status" data-testid="audio-degraded-note">
              No device is open — pick an output to re-enable audio.
            </div>
          )}
          <label className="pop-row"><span>Output device</span>
            <select aria-label="Output device" value={outVal}
                    onChange={(e) => void setDevice("output", e.target.value)}>
              {!outs.includes(outVal) && <option value="" disabled>Select output…</option>}
              {outs.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="pop-row"><span>Input device</span>
            <select aria-label="Input device" value={inVal}
                    onChange={(e) => void setDevice("input", e.target.value)}>
              {!ins.includes(inVal) && <option value="" disabled>Select input…</option>}
              {ins.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>

          <div className="pop-label">Track inputs</div>
          {tracks.length === 0 ? (
            <div className="pop-note">No tracks yet.</div>
          ) : tracks.map((t) => (
            <label className="pop-row" key={t.id}><span>{t.name}</span>
              <select aria-label={`Input for ${t.name}`} value={currentTrackInput(t)}
                      onChange={(e) => void setTrackInput(t.id, e.target.value)}>
                {inputOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
        </>
      )}
    </div>
  );
}

// ── existing Project file-management actions ────────────────────────────────
// Buttons are driven off the SAME FILE_MENU array the topbar File menu and the "+"
// file-options menu render from (menuActions.ts is the one source of truth for a
// project action's id/label; runAction is the one dispatcher) — this panel used to
// hand-roll its own New/Save/Save As/Open labels, which drifted from FILE_MENU in
// spirit even though the commands stayed correct (AL-018).
const PROJECT_ACTIONS = FILE_MENU.filter((m) => m.id !== "export_audio");

export function ProjectSettings({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.session;
  const run = (id: ActionId, opts?: { index?: number }) =>
    void runAction(id, { store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat }, opts);
  return (
    <div className="pop-group">
      <div className="pop-label">Project{s.dirty ? <span className="pop-note" title="Unsaved changes (auto-saved)"> • unsaved</span> : null}</div>
      <div className="pop-actions">
        {PROJECT_ACTIONS.map((m) => (
          <button key={m.id} className="btn" data-action={m.id} onClick={() => run(m.id)}>{m.label}</button>
        ))}
      </div>
      {(s.recentProjects?.length ?? 0) > 0 && (
        <>
          <div className="pop-label">Recent</div>
          <div className="modal-list" data-testid="recent-projects" style={{ maxHeight: 160 }}>
            {s.recentProjects!.slice(0, 8).map((p, i) => (
              <button key={p.path} className="plugin-row" title={p.path} disabled={p.path === s.editFile}
                      onClick={() => run("open_recent", { index: i })}>
                <span className="pr-name">{p.path === s.editFile ? "● " : ""}{p.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// The v2 shell is a single Mosh-native design with no skin/keymap/gesture/layout axis,
// so those settings (+ the DAW template picker) are hidden there — they'd be inert
// (effects pins data-skin=mosh) and confusing. The live clone keeps every
// live-effective axis (audio, keys, feel, layout, templates) and hides only the
// classic visual skin (settings/shellVisibility.ts owns the per-shell rules).
// Classic shows everything, unchanged.

export function SettingsPanel({ snapshot }: { snapshot: Snapshot }) {
  const v2 = isV2Active();
  const shell = activeShell();
  const groups = settingsByCategory()
    .map((g) => ({ ...g, settings: g.settings.filter((d) => !settingHiddenForShell(shell, g.category, d.id)) }))
    .filter((g) => g.settings.length > 0);
  return (
    <>
      <div className="pop-head">Settings</div>
      {!v2 && <TemplatePicker />}
      {groups.map((g) => (
        <div className="pop-group" key={g.category}>
          <div className="pop-label">{g.category}</div>
          {g.settings.map((def) => <SettingRow key={def.id} def={def} />)}
        </div>
      ))}
      <EngineSettings snapshot={snapshot} />
      <AudioRouting snapshot={snapshot} />
      <ProjectSettings snapshot={snapshot} />
    </>
  );
}

// Re-export so the orphaned-no-more SettingsPanel keeps a single import site.
export default SettingsPanel;
