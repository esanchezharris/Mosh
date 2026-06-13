#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "maolan-moshops-routing-gate.sh must run on macOS" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="${MOSH_APP_BIN:-$REPO_ROOT/build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}"
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="${2:?--output-dir requires a value}"
      shift 2
      ;;
    --help|-h)
      echo "Usage: maolan-moshops-routing-gate.sh [--output-dir DIR]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$OUTPUT_DIR" ]]; then
  DAY="$(date +%Y-%m-%d)"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  OUTPUT_DIR="$REPO_ROOT/_preserved_artifacts/${DAY}-maolan-moshops-routing/$STAMP"
fi

if [[ ! -x "$APP" ]]; then
  echo "Missing Mosh app binary: $APP" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR"

APP_STDOUT="$OUTPUT_DIR/app-maolan-moshops-routing.stdout.log"
APP_STDERR="$OUTPUT_DIR/app-maolan-moshops-routing.stderr.log"
SESSION_LOG="$HOME/Library/Mosh/session-selftest-maolan-moshops-routing/mosh-log.jsonl"

MOSH_NO_AUDIO=1 \
MOSH_ENGINE_BACKEND=maolan \
MOSH_REPO_ROOT="$REPO_ROOT" \
MOSH_ENGINE_CONTRACT_OUTPUT_DIR="$OUTPUT_DIR" \
  "$APP" -ApplePersistenceIgnoreState YES --selftest-maolan-moshops-routing \
  >"$APP_STDOUT" 2>"$APP_STDERR"

if [[ -f "$SESSION_LOG" ]]; then
  cp "$SESSION_LOG" "$OUTPUT_DIR/moshops-command-log.jsonl"
fi

python3 - "$OUTPUT_DIR" "$APP_STDOUT" "$APP_STDERR" <<'PY'
import json
import re
import sys
from pathlib import Path

out = Path(sys.argv[1])
stdout = Path(sys.argv[2])
stderr = Path(sys.argv[3])

backend_log = out / "command-log.jsonl"
moshops_log = out / "moshops-command-log.jsonl"
timing = out / "timing.csv"
render = out / "render-smoke" / "maolan-render-smoke.wav"
stats = out / "render-smoke" / "maolan-render-smoke-stats.json"
playback_stats = out / "playback-smoke" / "maolan-play-session-smoke-stats.json"
maolan_session = out / "render-smoke" / "maolan-session" / "main.json"
session = out / "session-graph.json"
restored = out / "restored-session-graph.json"

required = [backend_log, timing, render, stats, playback_stats, maolan_session, session, restored]
missing = [str(p) for p in required if not p.exists()]
if missing:
    raise SystemExit("missing required Maolan MoshOps artifacts: " + ", ".join(missing))
if render.stat().st_size <= 0:
    raise SystemExit(f"render WAV is empty: {render}")
playback = json.loads(playback_stats.read_text(encoding="utf-8"))
if playback.get("playback_source") != "maolan-session-playback":
    raise SystemExit(f"playback stats did not use Maolan session playback: {playback.get('playback_source')}")
if playback.get("play_started") is not True:
    raise SystemExit("playback stats do not confirm play start")
if playback.get("stop_confirmed") is not True:
    raise SystemExit("playback stats do not confirm stop")
if int(playback.get("transport_sample") or 0) <= 0:
    raise SystemExit("playback stats do not report transport movement")
if int(playback.get("vst3_instances") or 0) < 1:
    raise SystemExit("playback stats do not report a restored VST3 instance")
if int(playback.get("workers_ready") or 0) < int(playback.get("workers_total") or 1):
    raise SystemExit("playback stats report incomplete Maolan worker readiness")
during_play = playback.get("during_play") or {}
stopped = playback.get("stopped") or {}
if during_play.get("playing") is not True:
    raise SystemExit("playback stats do not show transport playing during probe")
if stopped.get("playing") is not False:
    raise SystemExit("playback stats do not show stopped transport after probe")

log_text = stderr.read_text(encoding="utf-8", errors="replace")
matches = re.findall(r"===== (\d+)/(\d+) Maolan MoshOps routing checks passed, (\d+) failed =====", log_text)
if not matches:
    raise SystemExit("missing Maolan MoshOps routing selftest summary")
passed, total, failed = map(int, matches[-1])
if failed != 0 or passed != total:
    raise SystemExit(f"Maolan MoshOps routing selftest failed: {passed}/{total}, failed={failed}")

ops = []
for line in backend_log.read_text(encoding="utf-8").splitlines():
    if line.strip():
        ops.append(json.loads(line).get("operation"))

for required_op in (
    "createSession",
    "selectAudioDevice",
    "scanPlugins",
    "getPluginBlocklist",
    "blockPlugin",
    "clearPluginBlocklist",
    "createTrack",
    "renameTrack",
    "removeTrack",
    "addClip",
    "getClipPeaks",
    "moveClip",
    "trimClip",
    "splitClip",
    "duplicateClip",
    "pasteClip",
    "deleteTimeRange",
    "renameClip",
    "removeClip",
    "setClipGain",
    "setClipMute",
    "setClipWarp",
    "addMidiClip",
    "addNote",
    "setNote",
    "quantizeNotes",
    "removeNote",
    "setTrackVolume",
    "setTrackPan",
    "setTrackMute",
    "setTrackSolo",
    "enableTrackMeter",
    "disableTrackMeter",
    "enableAllMeters",
    "setMasterVolume",
    "setMasterPan",
    "createBus",
    "renameBus",
    "addSend",
    "setSendLevel",
    "removeSend",
    "removeBus",
    "createGroupTrack",
    "ungroupTrack",
    "setTrackInput",
    "setTrackOutput",
    "armTrack",
    "setInputMonitor",
    "stopRecording",
    "setTempo",
    "insertTempoChange",
    "setTempoCurve",
    "removeTempoChange",
    "setTimeSignature",
    "insertTimeSigChange",
    "removeTimeSigChange",
    "setMetronome",
    "setProjectSettings",
    "loadPlugin",
    "setPluginParam",
    "reorderPlugin",
    "addAutomationPoint",
    "setAutomationPoint",
    "removeAutomationPoint",
    "clearAutomation",
    "bypassPlugin",
    "removePlugin",
    "setTransport",
    "renderExport",
    "saveSessionGraph",
    "restoreSessionGraph",
):
    if required_op not in ops:
        raise SystemExit(f"backend command log missing {required_op}: {ops}")

if not moshops_log.exists():
    raise SystemExit(f"missing MoshOps command log: {moshops_log}")
moshops_commands = []
for line in moshops_log.read_text(encoding="utf-8").splitlines():
    if line.strip():
        moshops_commands.append(json.loads(line).get("command"))
for required_command in (
    "import_clip",
    "import_clip_data",
    "add_midi_clip",
    "add_note",
    "set_note",
    "quantize_notes",
    "remove_note",
    "set_master_volume",
    "set_master_pan",
    "create_bus",
    "rename_bus",
    "add_send",
    "set_send_level",
    "remove_send",
    "remove_bus",
    "create_group_track",
    "ungroup_track",
    "set_track_input",
    "set_track_output",
    "enable_track_meter",
    "disable_track_meter",
    "enable_all_meters",
    "arm_track",
    "set_input_monitor",
    "stop_recording",
    "insert_tempo_change",
    "set_tempo_curve",
    "remove_tempo_change",
    "insert_time_sig_change",
    "remove_time_sig_change",
    "set_clip_warp",
    "block_plugin",
    "clear_plugin_blocklist",
    "reorder_plugin",
    "add_automation_point",
    "set_automation_point",
    "remove_automation_point",
    "clear_automation",
):
    if required_command not in moshops_commands:
        raise SystemExit(f"MoshOps command log missing {required_command}: {moshops_commands}")
for local_read in ("list_directory", "get_command_log", "get_plugin_blocklist", "list_colors", "list_midi_inputs", "list_builtins"):
    if local_read in moshops_commands:
        raise SystemExit(f"local read-only command should not be logged in MoshOps command log: {local_read}")
if ops.count("addClip") < 4:
    raise SystemExit(f"backend command log did not record enough file/test clip additions: {ops}")

render_stats = json.loads(stats.read_text(encoding="utf-8"))
if not render_stats.get("session_dir"):
    raise SystemExit("render stats do not prove Maolan session export")
if render_stats.get("render_source") != "maolan-offline-bounce":
    raise SystemExit(f"render stats did not use Maolan offline bounce: {render_stats.get('render_source')}")
if render_stats.get("plugin_graph_applied") is not True:
    raise SystemExit("render stats do not prove plugin graph application")
if int(render_stats.get("vst3_instances") or 0) < 1:
    raise SystemExit("render stats do not report a restored VST3 instance")
if int(render_stats.get("workers_ready") or 0) < int(render_stats.get("workers_total") or 1):
    raise SystemExit("render stats report incomplete Maolan worker readiness")
bounced_tracks = render_stats.get("bounced_tracks") or []
if not bounced_tracks:
    raise SystemExit("render stats do not include bounced track artifacts")
for bounced in bounced_tracks:
    path = Path(bounced.get("path") or "")
    if not path.exists() or path.stat().st_size <= 44:
        raise SystemExit(f"bounced track WAV missing or empty: {path}")
maolan_data = json.loads(maolan_session.read_text(encoding="utf-8"))
graphs = maolan_data.get("graphs") or {}
if not graphs:
    raise SystemExit("Maolan session JSON is missing native plugin graphs")
graph_values = list(graphs.values())
plugins = [plugin for graph in graph_values for plugin in (graph.get("plugins") or [])]
if not any(plugin.get("format") == "VST3" and "JamPilotTestGain.vst3" in (plugin.get("uri") or "") for plugin in plugins):
    raise SystemExit("Maolan session JSON does not include JamPilotTestGain.vst3 as a VST3 graph plugin")
def node_type(node):
    if isinstance(node, dict):
        return node.get("type")
    if node == "TrackInput":
        return "track_input"
    if node == "TrackOutput":
        return "track_output"
    return node
if not any(
    node_type(conn.get("from_node")) == "vst3_plugin" or node_type(conn.get("to_node")) == "vst3_plugin"
    for graph in graph_values
    for conn in (graph.get("connections") or [])
):
    raise SystemExit("Maolan session JSON does not connect the VST3 plugin graph")
session_graph = json.loads(session.read_text(encoding="utf-8"))
if session_graph.get("pluginBlocklist") not in ([], None):
    raise SystemExit(f"session graph should have cleared plugin blocklist, got {session_graph.get('pluginBlocklist')}")
if abs(float(session_graph.get("tempo", 0.0)) - 137.5) > 0.01:
    raise SystemExit(f"session graph did not preserve tempo: {session_graph.get('tempo')}")
if int(session_graph.get("timeSigNumerator") or 0) != 7:
    raise SystemExit(f"session graph did not preserve time signature numerator: {session_graph.get('timeSigNumerator')}")
if int(session_graph.get("timeSigDenominator") or 0) != 8:
    raise SystemExit(f"session graph did not preserve time signature denominator: {session_graph.get('timeSigDenominator')}")
if session_graph.get("metronome") is not True:
    raise SystemExit(f"session graph did not preserve metronome: {session_graph.get('metronome')}")
project = session_graph.get("project") or {}
if abs(float(project.get("sampleRate", 0.0)) - 96000.0) > 0.01:
    raise SystemExit(f"session graph did not preserve project sample rate: {project.get('sampleRate')}")
if int(project.get("bitDepth") or 0) != 16:
    raise SystemExit(f"session graph did not preserve project bit depth: {project.get('bitDepth')}")
if project.get("timeBase") != "barsBeats":
    raise SystemExit(f"session graph did not preserve project time base: {project.get('timeBase')}")
master = session_graph.get("master") or {}
if abs(float(master.get("volumeDb", 0.0)) - (-4.5)) > 0.01:
    raise SystemExit(f"session graph did not preserve master volume: {master.get('volumeDb')}")
if abs(float(master.get("pan", 0.0)) - (-1.0)) > 0.01:
    raise SystemExit(f"session graph did not preserve clamped master pan: {master.get('pan')}")
if session_graph.get("buses") not in ([], None):
    raise SystemExit(f"session graph should not retain routing bus after remove_bus: {session_graph.get('buses')}")
tracks = session_graph.get("tracks") or []
if len(tracks) != 1:
    raise SystemExit(f"session graph expected one final track, got {len(tracks)}")
track = tracks[0]
if abs(float(track.get("volumeDb", 0.0)) - (-6.5)) > 0.01:
    raise SystemExit(f"session graph did not preserve track volume: {track.get('volumeDb')}")
if abs(float(track.get("pan", 0.0)) - 1.0) > 0.01:
    raise SystemExit(f"session graph did not preserve clamped track pan: {track.get('pan')}")
if track.get("mute") is not False:
    raise SystemExit(f"session graph did not preserve final track mute state: {track.get('mute')}")
if track.get("solo") is not True:
    raise SystemExit(f"session graph did not preserve track solo: {track.get('solo')}")
if track.get("meterEnabled") is not True:
    raise SystemExit(f"session graph did not preserve track meter posture: {track.get('meterEnabled')}")
if track.get("armed") is not True:
    raise SystemExit(f"session graph did not preserve track arm posture: {track.get('armed')}")
if track.get("monitor") != "on":
    raise SystemExit(f"session graph did not preserve monitor posture: {track.get('monitor')}")
if (track.get("input") or {}).get("deviceID") != "input-3-4":
    raise SystemExit(f"session graph did not preserve input choice: {track.get('input')}")
if track.get("hasInput") is not False:
    raise SystemExit(f"session graph should report no live input binding: {track.get('hasInput')}")
if track.get("sends") not in ([], None):
    raise SystemExit(f"session graph should not retain send after remove_bus: {track.get('sends')}")
clips = track.get("clips") or []
if len(clips) != 4:
    raise SystemExit(f"session graph expected four final clips after duplicate and paste, got {len(clips)}")
clips_by_id = {clip.get("id"): clip for clip in clips}
expected_clips = {
    "clip-routing-1": {
        "name": "Maolan Routing Clip Edited",
        "startSeconds": 0.75,
        "lengthSeconds": 0.25,
        "offsetSeconds": 0.25,
        "gainDb": -3.5,
        "mute": False,
    },
    "clip-routing-1-split": {
        "name": "Maolan Routing Clip Edited",
        "startSeconds": 1.0,
        "lengthSeconds": 0.25,
        "offsetSeconds": 0.5,
        "gainDb": -3.5,
        "mute": False,
    },
    "clip-routing-1-copy": {
        "name": "Maolan Routing Clip Edited",
        "startSeconds": 1.25,
        "lengthSeconds": 0.25,
        "offsetSeconds": 0.5,
        "gainDb": -3.5,
        "mute": False,
    },
    "clip-routing-1-paste": {
        "name": "Maolan Routing Paste",
        "startSeconds": 1.75,
        "lengthSeconds": 0.25,
        "offsetSeconds": 0.5,
        "gainDb": -3.5,
        "mute": False,
    },
}
for clip_id, expected in expected_clips.items():
    clip = clips_by_id.get(clip_id)
    if clip is None:
        raise SystemExit(f"session graph missing split clip: {clip_id}")
    if clip.get("name") != expected["name"]:
        raise SystemExit(f"session graph did not preserve {clip_id} name: {clip.get('name')}")
    for key in ("startSeconds", "lengthSeconds", "offsetSeconds", "gainDb"):
        if abs(float(clip.get(key, 0.0)) - expected[key]) > 0.01:
            raise SystemExit(f"session graph did not preserve {clip_id} {key}: {clip.get(key)}")
    if clip.get("mute") is not expected["mute"]:
        raise SystemExit(f"session graph did not preserve {clip_id} mute state: {clip.get('mute')}")
    source = Path(clip.get("sourcePath") or "")
    if not source.exists() or source.stat().st_size <= 0:
        raise SystemExit(f"session graph clip source missing or empty for {clip_id}: {source}")
plugins = track.get("plugins") or []
if len(plugins) != 1:
    raise SystemExit(f"session graph expected one final plugin, got {len(plugins)}")
plugin = plugins[0]
if plugin.get("id") == "jampilot-remove-probe":
    raise SystemExit("session graph preserved the removed plugin probe")
if "JamPilotTestGain.vst3" not in plugin.get("path", ""):
    raise SystemExit(f"session graph did not preserve JamPilotTestGain.vst3: {plugin.get('path')}")
if plugin.get("enabled") is not False:
    raise SystemExit(f"session graph did not preserve plugin bypass state: {plugin.get('enabled')}")
params = plugin.get("params") or []
if len(params) != 1:
    raise SystemExit(f"session graph expected one plugin param, got {len(params)}")
param = params[0]
if int(param.get("index", -1)) != 0:
    raise SystemExit(f"session graph did not preserve plugin param index: {param.get('index')}")
if abs(float(param.get("value", 0.0)) - 0.42) > 0.01:
    raise SystemExit(f"session graph did not preserve plugin param value: {param.get('value')}")
summary = {
    "status": "PASS",
    "gate": "maolan-moshops-routing",
    "artifact_dir": str(out),
    "passed": passed,
    "total": total,
    "failed": failed,
    "backend_operations": ops,
    "artifacts": {
        "summary": str(out / "summary.json"),
        "app_stdout": str(stdout),
        "app_stderr": str(stderr),
        "backend_command_log": str(backend_log),
        "moshops_command_log": str(moshops_log) if moshops_log.exists() else "",
        "timing_csv": str(timing),
        "render_wav": str(render),
        "render_stats": str(stats),
        "playback_stats": str(playback_stats),
        "maolan_session_json": str(maolan_session),
        "session_graph": str(session),
        "restored_session_graph": str(restored),
    },
    "render": {
        "bytes": render_stats.get("bytes"),
        "duration_seconds": render_stats.get("duration_seconds"),
        "peak": render_stats.get("peak"),
        "rms": render_stats.get("rms"),
        "sample_rate": render_stats.get("sample_rate"),
        "frames": render_stats.get("frames"),
    },
    "playback": playback,
}
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
PY

echo "MOSH Maolan MoshOps routing: PASS"
echo "  Evidence: $OUTPUT_DIR"
echo "  Summary:  $OUTPUT_DIR/summary.json"
echo "  Commands: $OUTPUT_DIR/command-log.jsonl"
echo "  Timing:   $OUTPUT_DIR/timing.csv"
echo "  Render:   $OUTPUT_DIR/render-smoke/maolan-render-smoke.wav"
