import { useState } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile } from "../bridge";

const AUDIO_FILTER = "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.ogg";

// Settings / device-picker / project-lifecycle popover (wave: settings). Modeled
// on RemoteCompanion — reuses .tool-btn / .remote-pop / .error-bar styling, no new
// visual language. Every mutation goes through exec(...) (the seam); the file
// dialogs are native bridge fns that only resolve paths.
export function Settings() {
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const audioDevices = useStore((s) => s.audioDevices);
  const loadAudioDevices = useStore((s) => s.loadAudioDevices);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const uiScale = useStore((s) => s.uiScale);
  const setUiScale = useStore((s) => s.setUiScale);
  const [open, setOpen] = useState(false);

  const session = snapshot?.session;
  const audio = snapshot?.audio;
  // PRJ-008 — per-project format / time-base intent (the export/format default +
  // timeline display base). Generic media-format values; no engine concepts.
  const project = session?.project;
  const setProject = async (patch: Record<string, unknown>) => {
    await exec("set_project_settings", patch);
    await refresh();
  };
  // Project file filter/default come from the backend (session.projectExtension) so the
  // storage format stays out of the UI. Falls back to a generic "all files" before the
  // first snapshot loads — never hard-codes the engine's container extension.
  const projectExt = session?.projectExtension ?? "";
  const projectFilter = projectExt ? "*." + projectExt : "*";
  const projectDefault = projectExt ? "untitled." + projectExt : "untitled";
  const audioEnabled = session?.audioEnabled ?? false;

  // PRF-001 — multicore audio threads. Read the resolved values from the snapshot;
  // the stepper is clamped to [1..availableCores] (UI never sends 0 — 1 is single-thread).
  const cores = session?.availableCores;
  const threads = session?.audioThreads ?? cores ?? 1;
  const threadsAuto = session?.audioThreadsAuto ?? true;
  const setThreads = async (n: number) => {
    if (!cores) return;
    const clamped = Math.max(1, Math.min(cores, Math.round(n)));
    await exec("set_audio_threads", { threads: clamped });
    await refresh();
  };

  // Lazy device load on open (mirrors openBrowser/loadColors).
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadAudioDevices();
  };

  const currentType =
    audioDevices?.types.find((t) => t.name === (audio?.type ?? audioDevices.current.type)) ??
    audioDevices?.types[0];

  const setDevice = async (patch: Record<string, unknown>) => {
    await exec("set_audio_device", patch);
    await loadAudioDevices();
    await refresh();
  };

  const onImport = async () => {
    const r = await pickFiles({ multiple: true, filters: AUDIO_FILTER, title: "Import audio" });
    for (const f of r.files)
      await exec("import_clip", { file: f, trackId: selectedTrackId ?? undefined });
    await refresh();
  };

  const onOpenProject = async () => {
    const r = await pickFiles({ multiple: false, filters: projectFilter, title: "Open project" });
    if (r.ok && r.files[0]) {
      await exec("open_project", { file: r.files[0] });
      await refresh();
    }
  };

  const onSaveAs = async () => {
    const r = await pickSaveFile({ filters: projectFilter, title: "Save project as", defaultName: projectDefault });
    if (r.ok && r.file) {
      await exec("save_as", { file: r.file });
      await refresh();
    }
  };

  return (
    <div className="remote-companion">
      <button
        className={`tool-btn ${open ? "on" : ""}`}
        onClick={toggle}
        title="Settings — audio device & project"
      >
        ⚙
      </button>
      {open && (
        <div className="remote-pop settings-pop">
          <div className="remote-head">
            <strong>Settings</strong>
            <button className="mini" onClick={() => setOpen(false)}>x</button>
          </div>

          {!audioEnabled && (
            <div className="error-bar settings-gate">
              No audio device — playback / record / export disabled.
              <button className="mini-action" onClick={() => void loadAudioDevices()}>Re-scan</button>
            </div>
          )}

          {/* Audio device selection */}
          <div className="settings-group">
            <div className="settings-label">Audio device</div>

            <label className="settings-row">
              <span>Type</span>
              <select
                value={audio?.type ?? audioDevices?.current.type ?? ""}
                disabled={!audioEnabled || !audioDevices}
                onChange={(e) => void setDevice({ type: e.target.value })}
              >
                {(audioDevices?.types ?? []).map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span>Output</span>
              <select
                value={audio?.outputDevice ?? audioDevices?.current.outputDevice ?? ""}
                disabled={!audioEnabled || !currentType}
                onChange={(e) => void setDevice({ outputDevice: e.target.value })}
              >
                {(currentType?.outputs ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span>Input</span>
              <select
                value={audio?.inputDevice ?? audioDevices?.current.inputDevice ?? ""}
                disabled={!audioEnabled || !currentType}
                onChange={(e) => void setDevice({ inputDevice: e.target.value })}
              >
                <option value="">None</option>
                {(currentType?.inputs ?? []).map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span>Sample rate</span>
              <select
                value={String(audio?.sampleRate ?? session?.sampleRate ?? 0)}
                disabled={!audioEnabled || (audioDevices?.sampleRates.length ?? 0) === 0}
                onChange={(e) => void setDevice({ sampleRate: Number(e.target.value) })}
              >
                {(audioDevices?.sampleRates ?? []).map((sr) => (
                  <option key={sr} value={String(sr)}>{Math.round(sr)} Hz</option>
                ))}
              </select>
            </label>

            <label className="settings-row">
              <span>Buffer size</span>
              <select
                value={String(audio?.bufferSize ?? session?.bufferSize ?? 0)}
                disabled={!audioEnabled || (audioDevices?.bufferSizes.length ?? 0) === 0}
                onChange={(e) => void exec("set_buffer_size", { bufferSize: Number(e.target.value) }).then(() => { void loadAudioDevices(); void refresh(); })}
              >
                {(audioDevices?.bufferSizes ?? []).map((bs) => (
                  <option key={bs} value={String(bs)}>{bs} samples</option>
                ))}
              </select>
            </label>
          </div>

          {/* Read-only engine readout */}
          <div className="settings-group">
            <div className="settings-label">Engine</div>
            <div className="settings-readout">
              <span>Device</span><span>{session?.audioDeviceName || "—"}</span>
              <span>Bit depth</span><span>{session?.bitDepth ?? "—"}</span>
              <span>Output latency</span><span>{session?.outputLatencyMs != null ? `${session.outputLatencyMs.toFixed(1)} ms` : "—"}</span>
              <span>Round-trip</span><span>{session?.roundTripLatencyMs ? `${session.roundTripLatencyMs.toFixed(1)} ms` : "—"}</span>
            </div>
            <div className="settings-hint">Monitoring is software (buffer-bounded); a smaller buffer size lowers the round-trip delay.</div>
            {session?.audioDeviceError ? (
              <div className="settings-deverr">{session.audioDeviceError}</div>
            ) : null}
          </div>

          {/* Project format (PRJ-008). Per-project format / time-base INTENT — the
              remembered default for export + the timeline display base. Generic media
              format values (no engine concepts); valid headless. Persists with the
              project (saved on the Edit), so it survives reload. */}
          <div className="settings-group">
            <div className="settings-label">Project format</div>
            <label className="settings-row">
              <span>Sample rate</span>
              <select
                value={String(project?.sampleRate ?? 44100)}
                onChange={(e) => void setProject({ sampleRate: Number(e.target.value) })}
              >
                {[44100, 48000, 88200, 96000, 192000].map((sr) => (
                  <option key={sr} value={String(sr)}>{sr} Hz</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <span>Bit depth</span>
              <select
                value={String(project?.bitDepth ?? 24)}
                onChange={(e) => void setProject({ bitDepth: Number(e.target.value) })}
              >
                {[16, 24, 32].map((bd) => (
                  <option key={bd} value={String(bd)}>{bd}-bit</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <span>Time base</span>
              <select
                value={project?.timeBase ?? "seconds"}
                onChange={(e) => void setProject({ timeBase: e.target.value })}
              >
                <option value="seconds">Seconds</option>
                <option value="barsBeats">Bars &amp; beats</option>
              </select>
            </label>
          </div>

          {/* CPU / audio threads (PRF-001). A GENUINE preference — it drives the
              engine's parallel audio-graph thread count (1 = single-threaded). It is
              NOT a fake "enable multicore" switch; threads=1 IS the single-thread state.
              Valid even with no audio device (only the live re-apply needs a context),
              so it stays enabled headless. */}
          <div className="settings-group">
            <div className="settings-label">CPU / Audio threads</div>
            <div className="settings-readout">
              <span>Available cores</span><span>{cores ?? "—"}</span>
            </div>
            <label className="settings-row">
              <span>Threads</span>
              <span className="settings-stepper">
                <button
                  className="mini"
                  title="Fewer threads"
                  disabled={!cores || threads <= 1}
                  onClick={() => void setThreads(threads - 1)}
                >−</button>
                <span className="settings-threads-val">
                  {cores ? `${threads}${threadsAuto ? " (auto)" : ""}` : "—"}
                </span>
                <button
                  className="mini"
                  title="More threads"
                  disabled={!cores || threads >= (cores ?? 1)}
                  onClick={() => void setThreads(threads + 1)}
                >+</button>
              </span>
            </label>
            <div className="settings-hint">Changing the audio thread count may cause a brief audio glitch while playing.</div>
          </div>

          {/* Display — UI scale (ACC-005). Pure UI-local view state (like theme);
              never a command, never crosses the bridge. */}
          <div className="settings-group">
            <div className="settings-label">Display</div>
            <label className="settings-row">
              <span>UI scale</span>
              <span className="settings-stepper">
                <button
                  className="mini"
                  title="Smaller"
                  disabled={uiScale <= 0.8}
                  onClick={() => setUiScale(Math.round((uiScale - 0.1) * 10) / 10)}
                >A-</button>
                <span className="settings-scale-val">{Math.round(uiScale * 100)}%</span>
                <button
                  className="mini"
                  title="Larger"
                  disabled={uiScale >= 1.4}
                  onClick={() => setUiScale(Math.round((uiScale + 0.1) * 10) / 10)}
                >A+</button>
              </span>
            </label>
          </div>

          {/* Project / File menu */}
          <div className="settings-group">
            <div className="settings-label">Project</div>
            <div className="settings-files">
              <button className="tool-btn" onClick={() => void exec("new_project", {}).then(() => void refresh())}>New</button>
              <button className="tool-btn" onClick={onOpenProject}>Open…</button>
              <button className="tool-btn" onClick={() => void exec("save", {})}>Save</button>
              <button className="tool-btn" onClick={onSaveAs}>Save As…</button>
              <button className="tool-btn" onClick={onImport}>Import…</button>
            </div>
            <div className="settings-editfile" title={session?.editFile}>{session?.editFile}</div>
          </div>
        </div>
      )}
    </div>
  );
}
