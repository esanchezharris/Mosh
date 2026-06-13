#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "maolan-contract-slice-gate.sh must run on macOS" >&2
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
      echo "Usage: maolan-contract-slice-gate.sh [--output-dir DIR]"
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
  OUTPUT_DIR="$REPO_ROOT/_preserved_artifacts/${DAY}-maolan-contract/$STAMP"
fi

if [[ ! -x "$APP" ]]; then
  echo "Missing Mosh app binary: $APP" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR"

APP_STDOUT="$OUTPUT_DIR/app-contract-slice.stdout.log"
APP_STDERR="$OUTPUT_DIR/app-contract-slice.stderr.log"

MOSH_NO_AUDIO=1 \
MOSH_ENGINE_BACKEND=maolan \
MOSH_REPO_ROOT="$REPO_ROOT" \
MOSH_ENGINE_CONTRACT_OUTPUT_DIR="$OUTPUT_DIR" \
  "$APP" -ApplePersistenceIgnoreState YES --selftest-engine-contract-slice \
  >"$APP_STDOUT" 2>"$APP_STDERR"

SUMMARY="$OUTPUT_DIR/summary.json"
COMMAND_LOG="$OUTPUT_DIR/command-log.jsonl"
TIMING_CSV="$OUTPUT_DIR/timing.csv"
RENDER_WAV="$OUTPUT_DIR/render-smoke/maolan-render-smoke.wav"

python3 - "$OUTPUT_DIR" <<'PY'
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])
summary = out / "summary.json"
command_log = out / "command-log.jsonl"
timing = out / "timing.csv"
render = out / "render-smoke" / "maolan-render-smoke.wav"
stats = out / "render-smoke" / "maolan-render-smoke-stats.json"
playback_stats = out / "playback-smoke" / "maolan-play-session-smoke-stats.json"
maolan_session = out / "render-smoke" / "maolan-session" / "main.json"
session = out / "session-graph.json"
restored = out / "restored-session-graph.json"

required = [summary, command_log, timing, render, stats, playback_stats, maolan_session, session, restored]
missing = [str(p) for p in required if not p.exists()]
if missing:
    raise SystemExit("missing required Maolan contract artifacts: " + ", ".join(missing))
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

data = json.loads(summary.read_text(encoding="utf-8"))
if data.get("status") != "PASS":
    raise SystemExit(f"summary status is not PASS: {data.get('status')}")
if data.get("backend") != "maolan":
    raise SystemExit(f"summary backend is not maolan: {data.get('backend')}")
if data.get("device") != "coreaudio:default":
    raise SystemExit(f"summary device is not coreaudio:default: {data.get('device')}")
if not data.get("session_graph_restored"):
    raise SystemExit("session graph restore flag is false")

ops = []
for line in command_log.read_text(encoding="utf-8").splitlines():
    if line.strip():
        ops.append(json.loads(line).get("operation"))
expected = [
    "createSession",
    "selectAudioDevice",
    "setTempo",
    "setTimeSignature",
    "setMetronome",
    "setProjectSettings",
    "scanPlugins",
    "createTrack",
    "setTrackVolume",
    "setTrackPan",
    "setTrackMute",
    "setTrackSolo",
    "addClip",
    "getClipPeaks",
    "moveClip",
    "trimClip",
    "renameClip",
    "setClipGain",
    "setClipMute",
    "splitClip",
    "duplicateClip",
    "pasteClip",
    "addClip",
    "deleteTimeRange",
    "loadPlugin",
    "setPluginParam",
    "bypassPlugin",
    "loadPlugin",
    "removePlugin",
    "setTransport",
    "renderExport",
    "saveSessionGraph",
    "restoreSessionGraph",
    "diagnostics",
]
if ops != expected:
    raise SystemExit(f"unexpected command operation sequence: {ops}")

graph = json.loads(session.read_text(encoding="utf-8"))
if abs(float(graph.get("tempo", 0.0)) - 137.5) > 0.01:
    raise SystemExit(f"session graph did not preserve tempo: {graph.get('tempo')}")
if int(graph.get("timeSigNumerator") or 0) != 7:
    raise SystemExit(f"session graph did not preserve time signature numerator: {graph.get('timeSigNumerator')}")
if int(graph.get("timeSigDenominator") or 0) != 8:
    raise SystemExit(f"session graph did not preserve time signature denominator: {graph.get('timeSigDenominator')}")
if graph.get("metronome") is not True:
    raise SystemExit(f"session graph did not preserve metronome: {graph.get('metronome')}")
project = graph.get("project") or {}
if abs(float(project.get("sampleRate", 0.0)) - 96000.0) > 0.01:
    raise SystemExit(f"session graph did not preserve project sample rate: {project.get('sampleRate')}")
if int(project.get("bitDepth") or 0) != 16:
    raise SystemExit(f"session graph did not preserve project bit depth: {project.get('bitDepth')}")
if project.get("timeBase") != "barsBeats":
    raise SystemExit(f"session graph did not preserve project time base: {project.get('timeBase')}")
tracks = graph.get("tracks") or []
if len(tracks) != 1:
    raise SystemExit(f"session graph expected one track, got {len(tracks)}")
track = tracks[0]
if abs(float(track.get("volumeDb", 0.0)) - (-3.0)) > 0.01:
    raise SystemExit(f"session graph did not preserve track volume: {track.get('volumeDb')}")
if abs(float(track.get("pan", 0.0)) - 0.25) > 0.01:
    raise SystemExit(f"session graph did not preserve track pan: {track.get('pan')}")
if track.get("mute") is not False:
    raise SystemExit(f"session graph did not preserve track mute: {track.get('mute')}")
if track.get("solo") is not False:
    raise SystemExit(f"session graph did not preserve track solo: {track.get('solo')}")
clips = track.get("clips") or []
if len(clips) != 6:
    raise SystemExit(f"session graph expected duplicated, pasted, and range-deleted clip set, got {len(clips)}")
clip = clips[0]
if clip.get("name") != "Maolan Edited Tone":
    raise SystemExit(f"session graph did not preserve left clip name: {clip.get('name')}")
if abs(float(clip.get("startSeconds", 0.0)) - 0.25) > 0.01:
    raise SystemExit(f"session graph did not preserve left clip start: {clip.get('startSeconds')}")
if abs(float(clip.get("lengthSeconds", 0.0)) - 0.5) > 0.01:
    raise SystemExit(f"session graph did not preserve left clip length: {clip.get('lengthSeconds')}")
if abs(float(clip.get("offsetSeconds", 0.0)) - 0.1) > 0.01:
    raise SystemExit(f"session graph did not preserve left clip offset: {clip.get('offsetSeconds')}")
if abs(float(clip.get("gainDb", 0.0)) - (-2.5)) > 0.01:
    raise SystemExit(f"session graph did not preserve left clip gain: {clip.get('gainDb')}")
if clip.get("mute") is not False:
    raise SystemExit(f"session graph did not preserve left clip mute: {clip.get('mute')}")
source = Path(clip.get("sourcePath") or "")
if not source.exists() or source.stat().st_size <= 0:
    raise SystemExit(f"session graph left clip source missing or empty: {source}")
right = clips[1]
if right.get("id") != "clip-1-split":
    raise SystemExit(f"session graph did not preserve split clip id: {right.get('id')}")
if right.get("name") != "Maolan Edited Tone":
    raise SystemExit(f"session graph did not preserve right clip name: {right.get('name')}")
if abs(float(right.get("startSeconds", 0.0)) - 0.75) > 0.01:
    raise SystemExit(f"session graph did not preserve right clip start: {right.get('startSeconds')}")
if abs(float(right.get("lengthSeconds", 0.0)) - 0.75) > 0.01:
    raise SystemExit(f"session graph did not preserve right clip length: {right.get('lengthSeconds')}")
if abs(float(right.get("offsetSeconds", 0.0)) - 0.6) > 0.01:
    raise SystemExit(f"session graph did not preserve right clip offset: {right.get('offsetSeconds')}")
if abs(float(right.get("gainDb", 0.0)) - (-2.5)) > 0.01:
    raise SystemExit(f"session graph did not preserve right clip gain: {right.get('gainDb')}")
if right.get("mute") is not False:
    raise SystemExit(f"session graph did not preserve right clip mute: {right.get('mute')}")
source = Path(right.get("sourcePath") or "")
if not source.exists() or source.stat().st_size <= 0:
    raise SystemExit(f"session graph right clip source missing or empty: {source}")
copy = clips[2]
if copy.get("id") != "clip-1-copy":
    raise SystemExit(f"session graph did not preserve duplicate clip id: {copy.get('id')}")
if copy.get("name") != "Maolan Edited Tone":
    raise SystemExit(f"session graph did not preserve duplicate clip name: {copy.get('name')}")
if abs(float(copy.get("startSeconds", 0.0)) - 1.5) > 0.01:
    raise SystemExit(f"session graph did not preserve duplicate clip start: {copy.get('startSeconds')}")
if abs(float(copy.get("lengthSeconds", 0.0)) - 0.75) > 0.01:
    raise SystemExit(f"session graph did not preserve duplicate clip length: {copy.get('lengthSeconds')}")
if abs(float(copy.get("offsetSeconds", 0.0)) - 0.6) > 0.01:
    raise SystemExit(f"session graph did not preserve duplicate clip offset: {copy.get('offsetSeconds')}")
if abs(float(copy.get("gainDb", 0.0)) - (-2.5)) > 0.01:
    raise SystemExit(f"session graph did not preserve duplicate clip gain: {copy.get('gainDb')}")
if copy.get("mute") is not False:
    raise SystemExit(f"session graph did not preserve duplicate clip mute: {copy.get('mute')}")
source = Path(copy.get("sourcePath") or "")
if not source.exists() or source.stat().st_size <= 0:
    raise SystemExit(f"session graph duplicate clip source missing or empty: {source}")
pasted = clips[3]
if pasted.get("id") != "clip-1-paste":
    raise SystemExit(f"session graph did not preserve pasted clip id: {pasted.get('id')}")
if pasted.get("name") != "Maolan Pasted Tone":
    raise SystemExit(f"session graph did not preserve pasted clip name: {pasted.get('name')}")
if abs(float(pasted.get("startSeconds", 0.0)) - 2.25) > 0.01:
    raise SystemExit(f"session graph did not preserve pasted clip start: {pasted.get('startSeconds')}")
if abs(float(pasted.get("lengthSeconds", 0.0)) - 0.75) > 0.01:
    raise SystemExit(f"session graph did not preserve pasted clip length: {pasted.get('lengthSeconds')}")
if abs(float(pasted.get("offsetSeconds", 0.0)) - 0.6) > 0.01:
    raise SystemExit(f"session graph did not preserve pasted clip offset: {pasted.get('offsetSeconds')}")
if abs(float(pasted.get("gainDb", 0.0)) - (-2.5)) > 0.01:
    raise SystemExit(f"session graph did not preserve pasted clip gain: {pasted.get('gainDb')}")
if pasted.get("mute") is not False:
    raise SystemExit(f"session graph did not preserve pasted clip mute: {pasted.get('mute')}")
source = Path(pasted.get("sourcePath") or "")
if not source.exists() or source.stat().st_size <= 0:
    raise SystemExit(f"session graph pasted clip source missing or empty: {source}")
delete_left = clips[4]
if delete_left.get("id") != "clip-1-delete":
    raise SystemExit(f"session graph did not preserve delete-range left clip id: {delete_left.get('id')}")
if delete_left.get("name") != "Maolan Delete Range Tone":
    raise SystemExit(f"session graph did not preserve delete-range left clip name: {delete_left.get('name')}")
if abs(float(delete_left.get("startSeconds", 0.0)) - 3.0) > 0.01:
    raise SystemExit(f"session graph did not preserve delete-range left clip start: {delete_left.get('startSeconds')}")
if abs(float(delete_left.get("lengthSeconds", 0.0)) - 0.25) > 0.01:
    raise SystemExit(f"session graph did not preserve delete-range left clip length: {delete_left.get('lengthSeconds')}")
if abs(float(delete_left.get("offsetSeconds", 0.0)) - 0.0) > 0.01:
    raise SystemExit(f"session graph did not preserve delete-range left clip offset: {delete_left.get('offsetSeconds')}")
source = Path(delete_left.get("sourcePath") or "")
if not source.exists() or source.stat().st_size <= 0:
    raise SystemExit(f"session graph delete-range left clip source missing or empty: {source}")
delete_right = clips[5]
if delete_right.get("id") != "clip-1-delete-after-delete":
    raise SystemExit(f"session graph did not preserve delete-range right clip id: {delete_right.get('id')}")
if delete_right.get("name") != "Maolan Delete Range Tone":
    raise SystemExit(f"session graph did not preserve delete-range right clip name: {delete_right.get('name')}")
if abs(float(delete_right.get("startSeconds", 0.0)) - 3.5) > 0.01:
    raise SystemExit(f"session graph did not preserve delete-range right clip start: {delete_right.get('startSeconds')}")
if abs(float(delete_right.get("lengthSeconds", 0.0)) - 0.5) > 0.01:
    raise SystemExit(f"session graph did not preserve delete-range right clip length: {delete_right.get('lengthSeconds')}")
if abs(float(delete_right.get("offsetSeconds", 0.0)) - 0.5) > 0.01:
    raise SystemExit(f"session graph did not preserve delete-range right clip offset: {delete_right.get('offsetSeconds')}")
source = Path(delete_right.get("sourcePath") or "")
if not source.exists() or source.stat().st_size <= 0:
    raise SystemExit(f"session graph delete-range right clip source missing or empty: {source}")
plugins = track.get("plugins") or []
if len(plugins) != 1:
    raise SystemExit(f"session graph expected one plugin after removal probe, got {len(plugins)}")
plugin = plugins[0]
if "JamPilotTestGain.vst3" not in plugin.get("path", ""):
    raise SystemExit(f"session graph did not preserve JamPilotTestGain.vst3: {plugin.get('path')}")
if plugin.get("id") == "plugin-remove-probe":
    raise SystemExit("session graph preserved the removed plugin probe")
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
PY

echo "MOSH Maolan contract slice: PASS"
echo "  Evidence: $OUTPUT_DIR"
echo "  Summary:  $SUMMARY"
echo "  Commands: $COMMAND_LOG"
echo "  Timing:   $TIMING_CSV"
echo "  Render:   $RENDER_WAV"
