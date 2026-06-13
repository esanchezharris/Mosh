#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "maolan-persistence-restart-gate.sh must run on macOS" >&2
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
      echo "Usage: maolan-persistence-restart-gate.sh [--output-dir DIR]"
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
  OUTPUT_DIR="$REPO_ROOT/_preserved_artifacts/${DAY}-maolan-persistence-restart/$STAMP"
fi

if [[ ! -x "$APP" ]]; then
  echo "Missing Mosh app binary: $APP" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR/write" "$OUTPUT_DIR/read"

PERSISTED_GRAPH="$OUTPUT_DIR/persisted-session-graph.json"
WRITE_STDOUT="$OUTPUT_DIR/write/app.stdout.log"
WRITE_STDERR="$OUTPUT_DIR/write/app.stderr.log"
READ_STDOUT="$OUTPUT_DIR/read/app.stdout.log"
READ_STDERR="$OUTPUT_DIR/read/app.stderr.log"
WRITE_SESSION_LOG="$HOME/Library/Mosh/session-selftest-maolan-persistence-write/mosh-log.jsonl"
READ_SESSION_LOG="$HOME/Library/Mosh/session-selftest-maolan-persistence-read/mosh-log.jsonl"

MOSH_NO_AUDIO=1 \
MOSH_ENGINE_BACKEND=maolan \
MOSH_REPO_ROOT="$REPO_ROOT" \
MOSH_ENGINE_CONTRACT_OUTPUT_DIR="$OUTPUT_DIR/write" \
MOSH_MAOLAN_PERSISTENCE_PHASE=write \
MOSH_MAOLAN_PERSISTENCE_GRAPH="$PERSISTED_GRAPH" \
  "$APP" -ApplePersistenceIgnoreState YES --selftest-maolan-persistence-restart \
  >"$WRITE_STDOUT" 2>"$WRITE_STDERR"

if [[ -f "$WRITE_SESSION_LOG" ]]; then
  cp "$WRITE_SESSION_LOG" "$OUTPUT_DIR/write/moshops-command-log.jsonl"
fi

MOSH_NO_AUDIO=1 \
MOSH_ENGINE_BACKEND=maolan \
MOSH_REPO_ROOT="$REPO_ROOT" \
MOSH_ENGINE_CONTRACT_OUTPUT_DIR="$OUTPUT_DIR/read" \
MOSH_MAOLAN_PERSISTENCE_PHASE=read \
MOSH_MAOLAN_PERSISTENCE_GRAPH="$PERSISTED_GRAPH" \
  "$APP" -ApplePersistenceIgnoreState YES --selftest-maolan-persistence-restart \
  >"$READ_STDOUT" 2>"$READ_STDERR"

if [[ -f "$READ_SESSION_LOG" ]]; then
  cp "$READ_SESSION_LOG" "$OUTPUT_DIR/read/moshops-command-log.jsonl"
fi

python3 - "$OUTPUT_DIR" "$WRITE_STDOUT" "$WRITE_STDERR" "$READ_STDOUT" "$READ_STDERR" "$PERSISTED_GRAPH" <<'PY'
import json
import re
import sys
from pathlib import Path

out = Path(sys.argv[1])
write_stdout = Path(sys.argv[2])
write_stderr = Path(sys.argv[3])
read_stdout = Path(sys.argv[4])
read_stderr = Path(sys.argv[5])
persisted_graph = Path(sys.argv[6])

def parse_tally(path: Path, phase: str) -> tuple[int, int, int]:
    text = path.read_text(encoding="utf-8", errors="replace")
    matches = re.findall(
        rf"===== (\d+)/(\d+) Maolan persistence {phase} checks passed, (\d+) failed =====",
        text,
    )
    if not matches:
        raise SystemExit(f"missing Maolan persistence {phase} selftest summary in {path}")
    passed, total, failed = map(int, matches[-1])
    if failed != 0 or passed != total:
        raise SystemExit(f"Maolan persistence {phase} failed: {passed}/{total}, failed={failed}")
    return passed, total, failed

write_passed, write_total, write_failed = parse_tally(write_stderr, "write")
read_passed, read_total, read_failed = parse_tally(read_stderr, "read")

required = [
    persisted_graph,
    out / "write" / "command-log.jsonl",
    out / "write" / "timing.csv",
    out / "write" / "render-smoke" / "maolan-render-smoke.wav",
    out / "write" / "render-smoke" / "maolan-render-smoke-stats.json",
    out / "write" / "playback-smoke" / "maolan-play-session-smoke-stats.json",
    out / "write" / "render-smoke" / "maolan-session" / "main.json",
    out / "write" / "session-maolan" / "main.json",
    out / "read" / "command-log.jsonl",
    out / "read" / "render-smoke" / "maolan-render-smoke.wav",
    out / "read" / "render-smoke" / "maolan-render-smoke-stats.json",
    out / "read" / "playback-smoke" / "maolan-play-session-smoke-stats.json",
    out / "read" / "render-smoke" / "maolan-session" / "main.json",
    out / "read" / "session-maolan" / "main.json",
    out / "read" / "session-graph.json",
    out / "read" / "restored-session-graph.json",
]
missing = [str(p) for p in required if not p.exists()]
if missing:
    raise SystemExit("missing required Maolan persistence artifacts: " + ", ".join(missing))

for wav in (out / "write" / "render-smoke" / "maolan-render-smoke.wav",
            out / "read" / "render-smoke" / "maolan-render-smoke.wav"):
    if wav.stat().st_size <= 0:
        raise SystemExit(f"render WAV is empty: {wav}")

graph = json.loads(persisted_graph.read_text(encoding="utf-8"))
tracks = graph.get("tracks") or []
if graph.get("backend") != "maolan":
    raise SystemExit(f"persisted graph backend is not maolan: {graph.get('backend')}")
if graph.get("device") != "coreaudio:default":
    raise SystemExit(f"persisted graph device is not coreaudio:default: {graph.get('device')}")
if graph.get("pluginBlocklist") not in ([], None):
    raise SystemExit(f"persisted graph should have cleared plugin blocklist, got {graph.get('pluginBlocklist')}")
if abs(float(graph.get("tempo", 0.0)) - 132.0) > 0.01:
    raise SystemExit(f"persisted graph did not preserve tempo: {graph.get('tempo')}")
tempo_map = graph.get("tempoMap") or []
if len(tempo_map) != 2:
    raise SystemExit(f"persisted graph expected two tempo-map points, got {len(tempo_map)}")
if abs(float(tempo_map[0].get("curve", 1.0))) > 0.01:
    raise SystemExit(f"persisted graph did not preserve tempo curve metadata: {tempo_map[0]}")
if abs(float(tempo_map[1].get("time", 0.0)) - 8.0) > 0.01 or abs(float(tempo_map[1].get("bpm", 0.0)) - 96.0) > 0.01:
    raise SystemExit(f"persisted graph did not preserve inserted tempo-map point: {tempo_map[1]}")
if int(graph.get("timeSigNumerator") or 0) != 5:
    raise SystemExit(f"persisted graph did not preserve time signature numerator: {graph.get('timeSigNumerator')}")
if int(graph.get("timeSigDenominator") or 0) != 4:
    raise SystemExit(f"persisted graph did not preserve time signature denominator: {graph.get('timeSigDenominator')}")
time_sig_map = graph.get("timeSigMap") or []
if len(time_sig_map) != 2:
    raise SystemExit(f"persisted graph expected two time-signature map points, got {len(time_sig_map)}")
if abs(float(time_sig_map[1].get("time", 0.0)) - 16.0) > 0.01 or int(time_sig_map[1].get("numerator") or 0) != 3 or int(time_sig_map[1].get("denominator") or 0) != 4:
    raise SystemExit(f"persisted graph did not preserve inserted time-signature point: {time_sig_map[1]}")
if graph.get("metronome") is not True:
    raise SystemExit(f"persisted graph did not preserve metronome: {graph.get('metronome')}")
project = graph.get("project") or {}
if abs(float(project.get("sampleRate", 0.0)) - 88200.0) > 0.01:
    raise SystemExit(f"persisted graph did not preserve project sample rate: {project.get('sampleRate')}")
if int(project.get("bitDepth") or 0) != 32:
    raise SystemExit(f"persisted graph did not preserve project bit depth: {project.get('bitDepth')}")
if project.get("timeBase") != "barsBeats":
    raise SystemExit(f"persisted graph did not preserve project time base: {project.get('timeBase')}")
master = graph.get("master") or {}
if abs(float(master.get("volumeDb", 0.0)) - (-3.25)) > 0.01:
    raise SystemExit(f"persisted graph did not preserve master volume: {master.get('volumeDb')}")
if abs(float(master.get("pan", 0.0)) - 0.5) > 0.01:
    raise SystemExit(f"persisted graph did not preserve master pan: {master.get('pan')}")
buses = graph.get("buses") or []
if len(buses) != 1:
    raise SystemExit(f"persisted graph expected one bus, got {len(buses)}")
bus = buses[0]
if int(bus.get("bus", -1)) != 0:
    raise SystemExit(f"persisted graph did not preserve bus number: {bus.get('bus')}")
if bus.get("name") != "Maolan Persistence Bus Renamed":
    raise SystemExit(f"persisted graph did not preserve bus name: {bus.get('name')}")
if len(tracks) != 3:
    raise SystemExit(f"persisted graph expected source track plus bus return and group tracks, got {len(tracks)}")
track = tracks[0]
if abs(float(track.get("volumeDb", 0.0)) - (-5.5)) > 0.01:
    raise SystemExit(f"persisted graph did not preserve track volume: {track.get('volumeDb')}")
if abs(float(track.get("pan", 0.0)) - (-0.25)) > 0.01:
    raise SystemExit(f"persisted graph did not preserve track pan: {track.get('pan')}")
if track.get("mute") is not False:
    raise SystemExit(f"persisted graph did not preserve final track mute state: {track.get('mute')}")
if track.get("solo") is not True:
    raise SystemExit(f"persisted graph did not preserve track solo: {track.get('solo')}")
if track.get("meterEnabled") is not True:
    raise SystemExit(f"persisted graph did not preserve track meter posture: {track.get('meterEnabled')}")
if track.get("armed") is not True:
    raise SystemExit(f"persisted graph did not preserve track arm posture: {track.get('armed')}")
if track.get("monitor") != "on":
    raise SystemExit(f"persisted graph did not preserve monitor posture: {track.get('monitor')}")
if (track.get("input") or {}).get("deviceID") != "input-3-4":
    raise SystemExit(f"persisted graph did not preserve input choice: {track.get('input')}")
if track.get("hasInput") is not False:
    raise SystemExit(f"persisted graph should report no live input binding: {track.get('hasInput')}")
if track.get("parentId") != "group-persist":
    raise SystemExit(f"persisted graph did not preserve source track group parentId: {track.get('parentId')}")
sends = track.get("sends") or []
if len(sends) != 1:
    raise SystemExit(f"persisted graph expected one send, got {len(sends)}")
send = sends[0]
if int(send.get("bus", -1)) != 0:
    raise SystemExit(f"persisted graph did not preserve send bus: {send.get('bus')}")
if abs(float(send.get("db", 0.0)) - (-10.0)) > 0.01:
    raise SystemExit(f"persisted graph did not preserve send level: {send.get('db')}")
if send.get("mute") is not False:
    raise SystemExit(f"persisted graph did not preserve send mute: {send.get('mute')}")
return_track = tracks[1]
if return_track.get("isReturn") is not True:
    raise SystemExit(f"persisted graph did not preserve bus return track: {return_track}")
if int(return_track.get("returnBus", -1)) != 0:
    raise SystemExit(f"persisted graph did not preserve return bus number: {return_track.get('returnBus')}")
group_track = tracks[2]
if group_track.get("id") != "group-persist" or group_track.get("type") != "group" or group_track.get("isGroup") is not True:
    raise SystemExit(f"persisted graph did not preserve group track: {group_track}")
if group_track.get("name") != "Maolan Persistence Group":
    raise SystemExit(f"persisted graph did not preserve group name: {group_track.get('name')}")
plugins = tracks[0].get("plugins") or []
if len(plugins) != 2:
    raise SystemExit(f"persisted graph expected reordered two-plugin chain, got {len(plugins)}")
if plugins[0].get("id") != "jampilot-test-gain-vst3":
    raise SystemExit(f"persisted graph did not preserve primary plugin at index 0: {plugins[0].get('id')}")
if plugins[1].get("id") != "jampilot-persistence-reorder-probe":
    raise SystemExit(f"persisted graph did not preserve reorder probe at index 1: {plugins[1].get('id')}")
if "JamPilotTestGain.vst3" not in plugins[0].get("path", "") or "JamPilotTestGain.vst3" not in plugins[1].get("path", ""):
    raise SystemExit("persisted graph did not preserve JamPilotTestGain.vst3 plugin paths")
plugin = plugins[0]
if plugin.get("enabled") is not False:
    raise SystemExit(f"persisted graph did not preserve plugin bypass state: {plugin.get('enabled')}")
params = plugin.get("params") or []
if len(params) != 1:
    raise SystemExit(f"persisted graph expected one plugin param, got {len(params)}")
param = params[0]
if int(param.get("index", -1)) != 0:
    raise SystemExit(f"persisted graph did not preserve plugin param index: {param.get('index')}")
if abs(float(param.get("value", 0.0)) - 0.37) > 0.01:
    raise SystemExit(f"persisted graph did not preserve plugin param value: {param.get('value')}")
if param.get("automated") is not True:
    raise SystemExit(f"persisted graph did not preserve plugin automation flag: {param.get('automated')}")
points = param.get("points") or []
if len(points) != 1:
    raise SystemExit(f"persisted graph expected one plugin automation point, got {len(points)}")
point = points[0]
if abs(float(point.get("t", point.get("time", 0.0))) - 0.5) > 0.01:
    raise SystemExit(f"persisted graph did not preserve plugin automation time: {point}")
if abs(float(point.get("v", point.get("value", 0.0))) - 0.5) > 0.01:
    raise SystemExit(f"persisted graph did not preserve plugin automation value: {point}")
clips = track.get("clips") or []
if len(clips) != 7:
    raise SystemExit(f"persisted graph expected six audio clips plus one MIDI clip, got {len(clips)}")
clips_by_id = {clip.get("id"): clip for clip in clips}
expected_clips = {
    "clip-persist-1": {
        "name": "Maolan Persistence Clip Edited",
        "startSeconds": 0.5,
        "lengthSeconds": 0.5,
        "offsetSeconds": 0.2,
        "gainDb": -1.5,
        "mute": False,
    },
    "clip-persist-1-split": {
        "name": "Maolan Persistence Clip Edited",
        "startSeconds": 1.0,
        "lengthSeconds": 0.5,
        "offsetSeconds": 0.7,
        "gainDb": -1.5,
        "mute": False,
    },
    "clip-persist-1-copy": {
        "name": "Maolan Persistence Clip Edited",
        "startSeconds": 1.5,
        "lengthSeconds": 0.5,
        "offsetSeconds": 0.7,
        "gainDb": -1.5,
        "mute": False,
        "autoTempo": True,
        "sourceBpm": 132.0,
        "stretchMode": "soundtouch",
        "warpSourceLengthSeconds": 0.5,
    },
    "clip-persist-1-paste": {
        "name": "Maolan Persistence Paste",
        "startSeconds": 2.0,
        "lengthSeconds": 0.5,
        "offsetSeconds": 0.7,
        "gainDb": -1.5,
        "mute": False,
    },
    "clip-persist-delete": {
        "name": "Maolan Persistence Delete Range",
        "startSeconds": 2.5,
        "lengthSeconds": 0.25,
        "offsetSeconds": 0.0,
        "gainDb": 0.0,
        "mute": False,
    },
    "clip-persist-delete-after-delete": {
        "name": "Maolan Persistence Delete Range",
        "startSeconds": 3.0,
        "lengthSeconds": 0.5,
        "offsetSeconds": 0.5,
        "gainDb": 0.0,
        "mute": False,
    },
}
for clip_id, expected in expected_clips.items():
    clip = clips_by_id.get(clip_id)
    if clip is None:
        raise SystemExit(f"persisted graph missing split clip: {clip_id}")
    if clip.get("name") != expected["name"]:
        raise SystemExit(f"persisted graph did not preserve {clip_id} name: {clip.get('name')}")
    for key in ("startSeconds", "lengthSeconds", "offsetSeconds", "gainDb"):
        if abs(float(clip.get(key, 0.0)) - expected[key]) > 0.01:
            raise SystemExit(f"persisted graph did not preserve {clip_id} {key}: {clip.get(key)}")
    if clip.get("mute") is not expected["mute"]:
        raise SystemExit(f"persisted graph did not preserve {clip_id} mute: {clip.get('mute')}")
    if expected.get("autoTempo") is not None and clip.get("autoTempo") is not expected["autoTempo"]:
        raise SystemExit(f"persisted graph did not preserve {clip_id} autoTempo: {clip.get('autoTempo')}")
    if "sourceBpm" in expected and abs(float(clip.get("sourceBpm", 0.0)) - expected["sourceBpm"]) > 0.01:
        raise SystemExit(f"persisted graph did not preserve {clip_id} sourceBpm: {clip.get('sourceBpm')}")
    if "stretchMode" in expected and expected["stretchMode"] not in str(clip.get("stretchMode", "")).lower():
        raise SystemExit(f"persisted graph did not preserve {clip_id} stretchMode: {clip.get('stretchMode')}")
    if "warpSourceLengthSeconds" in expected and abs(float(clip.get("warpSourceLengthSeconds", 0.0)) - expected["warpSourceLengthSeconds"]) > 0.01:
        raise SystemExit(f"persisted graph did not preserve {clip_id} warpSourceLengthSeconds: {clip.get('warpSourceLengthSeconds')}")
    source = Path(clip.get("sourcePath") or "")
    if not source.exists() or source.stat().st_size <= 0:
        raise SystemExit(f"persisted graph clip source missing or empty for {clip_id}: {source}")

midi_clip = clips_by_id.get("clip-persist-midi")
if midi_clip is None:
    raise SystemExit("persisted graph missing MIDI clip")
if midi_clip.get("type") != "midi":
    raise SystemExit(f"persisted graph MIDI clip has wrong type: {midi_clip.get('type')}")
notes = midi_clip.get("notes") or []
if len(notes) != 3:
    raise SystemExit(f"persisted graph expected three MIDI notes after edit/remove, got {len(notes)}")
if int(notes[0].get("pitch", -1)) == 60:
    raise SystemExit(f"persisted graph did not preserve edited/removed MIDI notes: {notes}")
for note in notes:
    start = float(note.get("start", 0.0))
    if abs(start - round(start)) > 0.02:
        raise SystemExit(f"persisted graph did not preserve quantized MIDI note start: {notes}")

def operations(path: Path) -> list[str]:
    ops = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            ops.append(json.loads(line).get("operation"))
    return ops

def records(path: Path) -> list[dict]:
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            items.append(json.loads(line))
    return items

write_records = records(out / "write" / "command-log.jsonl")
read_records = records(out / "read" / "command-log.jsonl")
write_ops = [item.get("operation") for item in write_records]
read_ops = [item.get("operation") for item in read_records]
for op in (
    "createSession",
    "scanPlugins",
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
    "createGroupTrack",
    "addSend",
    "setSendLevel",
    "setTrackInput",
    "armTrack",
    "setInputMonitor",
    "stopRecording",
    "setTempo",
    "insertTempoChange",
    "setTempoCurve",
    "setTimeSignature",
    "insertTimeSigChange",
    "setMetronome",
    "setProjectSettings",
    "addClip",
    "getClipPeaks",
    "moveClip",
    "trimClip",
    "splitClip",
    "duplicateClip",
    "pasteClip",
    "deleteTimeRange",
    "renameClip",
    "setClipGain",
    "setClipMute",
    "setClipWarp",
    "addMidiClip",
    "addNote",
    "setNote",
    "quantizeNotes",
    "removeNote",
    "loadPlugin",
    "reorderPlugin",
    "setPluginParam",
    "addAutomationPoint",
    "setAutomationPoint",
    "removeAutomationPoint",
    "bypassPlugin",
    "setTransport",
    "renderExport",
    "saveSessionGraph",
):
    if op not in write_ops:
        raise SystemExit(f"write command log missing {op}: {write_ops}")
for op in ("openSession", "setTransport", "renderExport", "saveSessionGraph", "restoreSessionGraph"):
    if op not in read_ops:
        raise SystemExit(f"read command log missing {op}: {read_ops}")

write_persistence_maolan_session = out / "write" / "session-maolan" / "main.json"
read_persistence_maolan_session = out / "read" / "session-maolan" / "main.json"
def assert_operation_artifact(items, op, artifact, label):
    matches = [item for item in items if item.get("operation") == op and item.get("ok") is True]
    if not matches:
        raise SystemExit(f"{label} command log missing successful {op}")
    artifact_text = str(artifact)
    for item in matches:
        diagnostics = item.get("diagnostics") or {}
        paths = diagnostics.get("artifactPaths") or diagnostics.get("artifacts") or []
        if artifact_text in paths:
            return
    raise SystemExit(f"{label} {op} diagnostics do not include Maolan session JSON: {artifact_text}")
assert_operation_artifact(write_records, "saveSessionGraph", write_persistence_maolan_session, "write")
assert_operation_artifact(read_records, "openSession", read_persistence_maolan_session, "read")
assert_operation_artifact(read_records, "saveSessionGraph", read_persistence_maolan_session, "read")
assert_operation_artifact(read_records, "restoreSessionGraph", read_persistence_maolan_session, "read")

timing_lines = ["phase,seq,operation,ok,timing_ms,stdout_path,stderr_path"]
for phase, items in (("write", write_records), ("read", read_records)):
    for item in items:
        diagnostics = item.get("diagnostics") or {}
        timing_lines.append(",".join([
            phase,
            str(item.get("seq", "")),
            str(item.get("operation", "")),
            "true" if item.get("ok") else "false",
            str(diagnostics.get("timingMs", "")),
            str(diagnostics.get("stdoutPath", "")),
            str(diagnostics.get("stderrPath", "")),
        ]))
(out / "timing.csv").write_text("\n".join(timing_lines) + "\n", encoding="utf-8")

write_stats = json.loads((out / "write" / "render-smoke" / "maolan-render-smoke-stats.json").read_text(encoding="utf-8"))
read_stats = json.loads((out / "read" / "render-smoke" / "maolan-render-smoke-stats.json").read_text(encoding="utf-8"))
write_playback = json.loads((out / "write" / "playback-smoke" / "maolan-play-session-smoke-stats.json").read_text(encoding="utf-8"))
read_playback = json.loads((out / "read" / "playback-smoke" / "maolan-play-session-smoke-stats.json").read_text(encoding="utf-8"))
if not write_stats.get("session_dir"):
    raise SystemExit("write render stats do not prove Maolan session export")
if not read_stats.get("session_dir"):
    raise SystemExit("read render stats do not prove Maolan session export")
def assert_offline_bounce_stats(render_stats, label):
    if render_stats.get("render_source") != "maolan-offline-bounce":
        raise SystemExit(f"{label} render stats did not use Maolan offline bounce: {render_stats.get('render_source')}")
    if render_stats.get("plugin_graph_applied") is not True:
        raise SystemExit(f"{label} render stats do not prove plugin graph application")
    if int(render_stats.get("vst3_instances") or 0) < 1:
        raise SystemExit(f"{label} render stats do not report a restored VST3 instance")
    if int(render_stats.get("workers_ready") or 0) < int(render_stats.get("workers_total") or 1):
        raise SystemExit(f"{label} render stats report incomplete Maolan worker readiness")
    bounced_tracks = render_stats.get("bounced_tracks") or []
    if not bounced_tracks:
        raise SystemExit(f"{label} render stats do not include bounced track artifacts")
    for bounced in bounced_tracks:
        path = Path(bounced.get("path") or "")
        if not path.exists() or path.stat().st_size <= 44:
            raise SystemExit(f"{label} bounced track WAV missing or empty: {path}")
assert_offline_bounce_stats(write_stats, "write")
assert_offline_bounce_stats(read_stats, "read")
def assert_playback_stats(playback, label):
    if playback.get("playback_source") != "maolan-session-playback":
        raise SystemExit(f"{label} playback stats did not use Maolan session playback: {playback.get('playback_source')}")
    if playback.get("play_started") is not True:
        raise SystemExit(f"{label} playback stats do not confirm play start")
    if playback.get("stop_confirmed") is not True:
        raise SystemExit(f"{label} playback stats do not confirm stop")
    if int(playback.get("transport_sample") or 0) <= 0:
        raise SystemExit(f"{label} playback stats do not report transport movement")
    if int(playback.get("vst3_instances") or 0) < 1:
        raise SystemExit(f"{label} playback stats do not report a restored VST3 instance")
    if int(playback.get("workers_ready") or 0) < int(playback.get("workers_total") or 1):
        raise SystemExit(f"{label} playback stats report incomplete Maolan worker readiness")
    during_play = playback.get("during_play") or {}
    stopped = playback.get("stopped") or {}
    if during_play.get("playing") is not True:
        raise SystemExit(f"{label} playback stats do not show transport playing during probe")
    if stopped.get("playing") is not False:
        raise SystemExit(f"{label} playback stats do not show stopped transport after probe")
assert_playback_stats(write_playback, "write")
assert_playback_stats(read_playback, "read")
def node_type(node):
    if isinstance(node, dict):
        return node.get("type")
    if node == "TrackInput":
        return "track_input"
    if node == "TrackOutput":
        return "track_output"
    return node
def assert_maolan_plugin_graph(path, label):
    maolan_data = json.loads(path.read_text(encoding="utf-8"))
    graphs = maolan_data.get("graphs") or {}
    if not graphs:
        raise SystemExit(f"{label} Maolan session JSON is missing native plugin graphs")
    graph_values = list(graphs.values())
    plugins = [plugin for graph in graph_values for plugin in (graph.get("plugins") or [])]
    if not any(plugin.get("format") == "VST3" and "JamPilotTestGain.vst3" in (plugin.get("uri") or "") for plugin in plugins):
        raise SystemExit(f"{label} Maolan session JSON does not include JamPilotTestGain.vst3 as a VST3 graph plugin")
    if not any(
        node_type(conn.get("from_node")) == "vst3_plugin" or node_type(conn.get("to_node")) == "vst3_plugin"
        for graph in graph_values
        for conn in (graph.get("connections") or [])
    ):
        raise SystemExit(f"{label} Maolan session JSON does not connect the VST3 plugin graph")
assert_maolan_plugin_graph(out / "write" / "render-smoke" / "maolan-session" / "main.json", "write")
assert_maolan_plugin_graph(out / "read" / "render-smoke" / "maolan-session" / "main.json", "read")
assert_maolan_plugin_graph(out / "write" / "session-maolan" / "main.json", "write persistence")
assert_maolan_plugin_graph(out / "read" / "session-maolan" / "main.json", "read persistence")

summary = {
    "status": "PASS",
    "gate": "maolan-persistence-restart",
    "artifact_dir": str(out),
    "persisted_graph": str(persisted_graph),
    "timing_csv": str(out / "timing.csv"),
    "write": {
        "passed": write_passed,
        "total": write_total,
        "failed": write_failed,
        "operations": write_ops,
        "stdout": str(write_stdout),
        "stderr": str(write_stderr),
        "command_log": str(out / "write" / "command-log.jsonl"),
        "moshops_command_log": str(out / "write" / "moshops-command-log.jsonl"),
        "timing_csv": str(out / "write" / "timing.csv"),
        "render_wav": str(out / "write" / "render-smoke" / "maolan-render-smoke.wav"),
        "render_stats": str(out / "write" / "render-smoke" / "maolan-render-smoke-stats.json"),
        "playback_stats": str(out / "write" / "playback-smoke" / "maolan-play-session-smoke-stats.json"),
        "maolan_session_json": str(out / "write" / "render-smoke" / "maolan-session" / "main.json"),
        "persistence_maolan_session_json": str(out / "write" / "session-maolan" / "main.json"),
        "render": write_stats,
        "playback": write_playback,
    },
    "read": {
        "passed": read_passed,
        "total": read_total,
        "failed": read_failed,
        "operations": read_ops,
        "stdout": str(read_stdout),
        "stderr": str(read_stderr),
        "command_log": str(out / "read" / "command-log.jsonl"),
        "moshops_command_log": str(out / "read" / "moshops-command-log.jsonl"),
        "render_wav": str(out / "read" / "render-smoke" / "maolan-render-smoke.wav"),
        "render_stats": str(out / "read" / "render-smoke" / "maolan-render-smoke-stats.json"),
        "playback_stats": str(out / "read" / "playback-smoke" / "maolan-play-session-smoke-stats.json"),
        "maolan_session_json": str(out / "read" / "render-smoke" / "maolan-session" / "main.json"),
        "persistence_maolan_session_json": str(out / "read" / "session-maolan" / "main.json"),
        "session_graph": str(out / "read" / "session-graph.json"),
        "restored_session_graph": str(out / "read" / "restored-session-graph.json"),
        "render": read_stats,
        "playback": read_playback,
    },
}
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
PY

echo "MOSH Maolan persistence restart: PASS"
echo "  Evidence:  $OUTPUT_DIR"
echo "  Summary:   $OUTPUT_DIR/summary.json"
echo "  Persisted: $PERSISTED_GRAPH"
echo "  Write WAV: $OUTPUT_DIR/write/render-smoke/maolan-render-smoke.wav"
echo "  Read WAV:  $OUTPUT_DIR/read/render-smoke/maolan-render-smoke.wav"
