import { useEffect, useState } from "react";
import { useStore } from "../store";

type WorkflowState = {
  sessionId: string;
  device: string;
  pluginPath: string;
  trackId: string;
  clipId: string;
  splitClipId: string;
  pluginId: string;
  renderFile: string;
  renderStats: string;
  playbackStats: string;
  sessionGraph: string;
  restoredGraph: string;
  maolanSessionJson: string;
  outputDir: string;
  status: string;
  ok: boolean | null;
};

type PluginRow = {
  id?: string;
  name?: string;
  path?: string;
  format?: string;
};

const JAM_PILOT =
  "/Users/emiliosanchez-harris/Library/Audio/Plug-Ins/VST3/JamPilotTestGain.vst3";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function fileLabel(path: string): string {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function EngineContractPanel() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowState>({
    sessionId: "mosh-ui-maolan-slice",
    device: "coreaudio:default",
    pluginPath: JAM_PILOT,
    trackId: "",
    clipId: "",
    splitClipId: "",
    pluginId: "",
    renderFile: "",
    renderStats: "",
    playbackStats: "",
    sessionGraph: "",
    restoredGraph: "",
    maolanSessionJson: "",
    outputDir: "",
    status: "idle",
    ok: null,
  });
  const snapshot = useStore((s) => s.snapshot);
  const diagnostics = useStore((s) => s.engineDiagnostics);
  const slice = useStore((s) => s.engineSlice);
  const running = useStore((s) => s.engineSliceRunning);
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const loadDiagnostics = useStore((s) => s.loadEngineDiagnostics);
  const runSlice = useStore((s) => s.runEngineContractSlice);

  const backend = snapshot?.session.backend ?? "maolan";
  const backendName = snapshot?.session.backendDisplayName ?? backend;
  const capabilities = snapshot?.session.backendCapabilities ?? [];
  const isMaolan = backend === "maolan";
  const canRunSlice = isMaolan;
  const fixture = diagnostics?.fixturePlugin ?? workflow.pluginPath ?? JAM_PILOT;
  const ready = isMaolan
    ? Boolean(diagnostics?.envFileExists && diagnostics?.scriptExists && diagnostics?.fixturePluginExists)
    : true;

  useEffect(() => {
    if (open) void loadDiagnostics();
  }, [open, loadDiagnostics]);

  const runStep = async (label: string, command: string, args: Record<string, unknown> = {}) => {
    setBusy(label);
    setWorkflow((w) => ({ ...w, status: `${label} running`, ok: null }));
    const res = await exec(command, args);
    setBusy("");
    if (!res.ok) {
      setWorkflow((w) => ({ ...w, status: res.error ?? `${label} failed`, ok: false }));
      return null;
    }
    setWorkflow((w) => ({ ...w, status: `${label} ok`, ok: true }));
    await refresh();
    return asRecord(res.data);
  };

  const createSession = async () => {
    const data = await runStep("session", "new_project", {
      sessionId: workflow.sessionId,
    });
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      sessionGraph: asString(data.sessionGraph) || asString(data.editFile) || w.sessionGraph,
      outputDir: asString(data.outputDir) || w.outputDir,
      sessionId: asString(data.sessionId) || w.sessionId,
    }));
    return data;
  };

  const selectDevice = async () => {
    const data = await runStep("device", "set_audio_device", { device: "coreaudio:default" });
    if (!data) return null;
    setWorkflow((w) => ({ ...w, device: asString(data.device) || "coreaudio:default" }));
    return data;
  };

  const scanPlugins = async () => {
    const scan = await runStep("scan", "rescan_plugins", { format: "vst3" });
    if (!scan) return null;
    const listed = await runStep("plugins", "list_plugins", {});
    if (!listed) return null;
    const rows = Array.isArray(listed.plugins) ? (listed.plugins as PluginRow[]) : [];
    setPlugins(rows);
    const jam = rows.find((p) => (p.path ?? "").includes("JamPilotTestGain.vst3")) ?? rows[0];
    if (jam)
      setWorkflow((w) => ({
        ...w,
        pluginId: jam.id ?? w.pluginId,
        pluginPath: jam.path ?? w.pluginPath,
      }));
    return listed;
  };

  const createTrack = async () => {
    const data = await runStep("track", "create_track", { name: "Maolan UI Track" });
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      trackId: asString(data.trackId) || asString(data.id) || w.trackId,
      sessionGraph: asString(data.sessionGraph) || w.sessionGraph,
    }));
    return data;
  };

  const loadPlugin = async (trackId = workflow.trackId || "track-1", pluginPath = workflow.pluginPath || fixture) => {
    const data = await runStep("plugin", "load_plugin", {
      trackId,
      pluginId: workflow.pluginId || "jampilot-test-gain-vst3",
      pluginPath,
    });
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      trackId: asString(data.trackId) || trackId,
      pluginId: asString(data.pluginId) || w.pluginId,
      pluginPath: asString(data.pluginPath) || asString(data.file) || pluginPath,
      sessionGraph: asString(data.sessionGraph) || w.sessionGraph,
    }));
    return data;
  };

  const addToneClip = async (trackId = workflow.trackId || "track-1") => {
    const data = await runStep("clip", "add_test_tone_clip", {
      trackId,
      clipId: "maolan-ui-tone-1",
      name: "Maolan UI Tone",
      seconds: 1.0,
      freq: 330.0,
      start: 0,
    });
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      trackId: asString(data.trackId) || trackId,
      clipId: asString(data.clipId) || asString(data.id) || w.clipId,
      sessionGraph: asString(data.sessionGraph) || w.sessionGraph,
    }));
    return data;
  };

  const splitToneClip = async (clipId = workflow.clipId || "maolan-ui-tone-1") => {
    const data = await runStep("split", "split_clip", {
      clipId,
      time: 0.5,
      newClipId: "maolan-ui-tone-1-split",
    });
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      splitClipId: asString(data.newClipId) || asString(data.rightClipId) || w.splitClipId,
      sessionGraph: asString(data.sessionGraph) || w.sessionGraph,
    }));
    return data;
  };

  const stopTransport = async () => {
    const data = await runStep("transport", "set_transport", { action: "stop", position: 0 });
    if (!data) return null;
    const position = asNumber(data.position);
    setWorkflow((w) => ({
      ...w,
      status: position != null ? `transport ${position.toFixed(2)}s` : "transport stopped",
      ok: true,
    }));
    return data;
  };

  const playTransport = async () => {
    const data = await runStep("play", "set_transport", { action: "play", durationSeconds: 0.5 });
    if (!data) return null;
    const position = asNumber(data.position);
    setWorkflow((w) => ({
      ...w,
      playbackStats: asString(data.playbackStats) || w.playbackStats,
      status: position != null ? `played ${position.toFixed(2)}s` : "playback checked",
      ok: true,
    }));
    return data;
  };

  const renderAudio = async (trackId = workflow.trackId || "track-1") => {
    const data = await runStep("render", "export_audio", { trackId });
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      renderFile: asString(data.file) || w.renderFile,
      renderStats: asString(data.statsPath) || w.renderStats,
    }));
    return data;
  };

  const saveGraph = async () => {
    const data = await runStep("save", "save", {});
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      sessionGraph: asString(data.file) || w.sessionGraph,
      maolanSessionJson: asString(data.maolanSessionJson) || w.maolanSessionJson,
    }));
    return data;
  };

  const restoreGraph = async () => {
    const data = await runStep("restore", "reload", {});
    if (!data) return null;
    setWorkflow((w) => ({
      ...w,
      restoredGraph: asString(data.restoredFile) || w.restoredGraph,
      sessionGraph: asString(data.file) || w.sessionGraph,
      maolanSessionJson: asString(data.maolanSessionJson) || w.maolanSessionJson,
    }));
    return data;
  };

  const runWorkflow = async () => {
    const session = await createSession();
    if (!session) return;
    if (!(await selectDevice())) return;
    if (!(await scanPlugins())) return;
    const track = await createTrack();
    if (!track) return;
    const trackId = asString(track.trackId) || asString(track.id) || "track-1";
    if (!(await loadPlugin(trackId, fixture))) return;
    if (!(await addToneClip(trackId))) return;
    if (!(await splitToneClip("maolan-ui-tone-1"))) return;
    if (!(await playTransport())) return;
    if (!(await renderAudio(trackId))) return;
    if (!(await saveGraph())) return;
    if (!(await restoreGraph())) return;
    await loadDiagnostics();
    setWorkflow((w) => ({ ...w, status: "workflow pass", ok: true }));
  };

  const disabled = !isMaolan || Boolean(busy);
  const artifactLinks = [
    workflow.renderFile,
    workflow.renderStats,
    workflow.playbackStats,
    workflow.sessionGraph,
    workflow.restoredGraph,
    workflow.maolanSessionJson,
    workflow.outputDir,
    slice?.data?.summaryPath ?? "",
  ].filter(Boolean);

  return (
    <div className="engine-contract">
      <button
        className={`tool-btn engine-btn ${ready ? "on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Engine backend"
      >
        Engine
      </button>
      {open && (
        <div className="remote-pop engine-pop">
          <div className="remote-head">
            <strong>{backendName}</strong>
            <button className="mini" onClick={() => void loadDiagnostics()} title="Refresh">R</button>
          </div>

          <div className="engine-readout">
            <span>Backend</span><b>{backend}</b>
            <span>Device</span><b>{diagnostics?.supportedDevice ?? "reference"}</b>
            <span>Env</span><b>{diagnostics?.envFileExists === false ? "missing" : "ready"}</b>
            <span>Script</span><b>{diagnostics?.scriptExists === false ? "missing" : "ready"}</b>
          </div>

          <div className="engine-actions">
            <button
              className="tool-btn"
              disabled={!canRunSlice || running}
              onClick={() => void runSlice()}
            >
              {running ? "Running" : "Run slice"}
            </button>
            {slice?.data?.summaryPath && (
              <span className="engine-path" title={slice.data.summaryPath}>
                {slice.ok ? "PASS" : "FAIL"} {slice.data.summaryPath}
              </span>
            )}
          </div>

          <div className="engine-workflow">
            <div className="engine-section-title">Maolan workflow</div>
            <div className="engine-actions engine-actions-grid">
              <button className="tool-btn" disabled={disabled} onClick={() => void createSession()}>Session</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void selectDevice()}>Device</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void scanPlugins()}>Scan</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void createTrack()}>Track</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void loadPlugin()}>Plugin</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void addToneClip()}>Clip</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void splitToneClip()}>Split</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void playTransport()}>Play</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void stopTransport()}>Stop</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void renderAudio()}>Render</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void saveGraph()}>Save</button>
              <button className="tool-btn" disabled={disabled} onClick={() => void restoreGraph()}>Restore</button>
            </div>
            <button className="tool-btn engine-run" disabled={disabled} onClick={() => void runWorkflow()}>
              {busy ? `${busy}...` : "Run workflow"}
            </button>

            <div className={`engine-status ${workflow.ok === false ? "err" : workflow.ok ? "ok" : ""}`}>
              {busy ? `${busy} running` : workflow.status}
            </div>

            <div className="engine-readout">
              <span>Track</span><b>{workflow.trackId || "-"}</b>
              <span>Clip</span><b>{workflow.clipId || "-"}</b>
              <span>Split</span><b>{workflow.splitClipId || "-"}</b>
              <span>Plugin</span><b>{fileLabel(workflow.pluginPath || fixture) || "-"}</b>
              <span>Render</span><b>{fileLabel(workflow.renderFile) || "-"}</b>
              <span>Playback</span><b>{fileLabel(workflow.playbackStats) || "-"}</b>
              <span>Graph</span><b>{fileLabel(workflow.sessionGraph) || "-"}</b>
              <span>Native</span><b>{fileLabel(workflow.maolanSessionJson) || "-"}</b>
            </div>

            {plugins.length > 0 && (
              <div className="engine-plugin-list">
                {plugins.slice(0, 3).map((plugin) => (
                  <div key={plugin.id ?? plugin.path ?? plugin.name} className="engine-plugin-row">
                    <span>{plugin.name ?? fileLabel(plugin.path ?? "")}</span>
                    <b>{plugin.format ?? "vst3"}</b>
                  </div>
                ))}
              </div>
            )}

            {artifactLinks.length > 0 && (
              <div className="engine-artifacts">
                {artifactLinks.map((path) => (
                  <div key={path} className="engine-path" title={path}>
                    {fileLabel(path)}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="engine-caps">
            {capabilities.slice(0, 8).map((cap) => (
              <div key={cap.operation} className={`engine-cap ${cap.supported ? "ok" : "off"}`}>
                <span>{cap.operation}</span>
                <b>{cap.status}</b>
              </div>
            ))}
          </div>

          {diagnostics?.fixturePlugin && (
            <div className="engine-path" title={diagnostics.fixturePlugin}>
              {diagnostics.fixturePlugin}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
