#pragma once

namespace mosh
{
class MoshEngine;
class MoshOps;

/** The command-surface harness (06 §4), runnable headlessly via `Mosh --selftest`.
    Drives MoshOps through a scripted sequence and asserts results, emitted events,
    JSONL log lines, and snapshot state — proving the Stage 1 gate logic without
    the UI. Returns 0 on success, the number of failed checks otherwise. */
int runSelfTest (MoshEngine&, MoshOps&);

/** Focused strict-mode probe for the Tracktion undo chain used by Stage 1.
    Keeps assertion debugging separate from plugin hosting and generative jobs. */
int runUndoSelfTest (MoshEngine&, MoshOps&);

int runGoldenSelfTest (MoshEngine&, MoshOps&);

/** Headless batch command runner (`Mosh --run-script`). Reads a JSONL command
    script from MOSH_RUN_SCRIPT — one {"command","args"} object per line; blank lines
    and #/// comments are skipped; {"command":"__wait","args":{"ms":N}} pumps the
    message loop so async work (e.g. a generative render job) can complete — executes
    each via MoshOps::execute against an isolated headless session, and writes each
    result as one JSONL line to stdout (and to MOSH_RUN_SCRIPT_OUT if set). Returns the
    number of failed commands. Composed with `export_audio`, this is the driver behind
    the offline render-to-WAV hardware-verification harness. */
int runCommandScript (MoshEngine&, MoshOps&);

/** Opens the real audio device path, plays a deterministic tone briefly, and
    exits. Used by the BlackHole virtual loopback gate. */
int runLiveAudioSmoke (MoshEngine&, MoshOps&);

/** REC-002 — `Mosh --midi-record-smoke`: the live-MIDI-capture path end to end, with
    nobody playing a keyboard. Arms a track to the virtual "Mosh Keyboard" input, plays
    notes through it, and asserts they land in a recorded take, that Capture MIDI recovers
    notes played while NOT recording, and that overdub merges rather than replaces.

    Its own mode rather than a --selftest section because it needs a real audio device:
    with none open there are no input instances, so the routing fork in cmdAuditionNote is
    never taken and the retrospective buffer never fills. Proves nothing about AUDIBILITY
    — that is --live-audio-smoke's job. */
int runMidiRecordSmoke (MoshEngine&, MoshOps&);

/** LAT-001 — `Mosh --latency-calibration-smoke`: the measured-latency path end to end
    through a loopback device, with nobody at the mic. Pair MOSH_AUDIO_OUTPUT_DEVICE and
    MOSH_AUDIO_INPUT_DEVICE with "BlackHole 2ch" so the sweep the calibration plays comes
    straight back as input. Asserts a measurement lands (never a silent number), that
    its residual is applied, and - the part that matters - that a click played at 1.0 s
    and recorded through the same loopback lands within 1 ms of 1.0 s. Its own mode
    because it needs a real device; proves nothing about AUDIBILITY (that is
    --live-audio-smoke's job). */
int runLatencyCalibrationSmoke (MoshEngine&, MoshOps&);

/** Voice STT smoke (`Mosh --voice-smoke`): synthesizes a known phrase with macOS
    `say`, transcribes it through SFSpeechRecognizer, and asserts the transcript
    matches — proving the speech-to-text path end-to-end with nobody speaking. FILE
    mode (default) needs only Speech-Recognition auth (no mic). MIC mode
    (MOSH_VOICE_SMOKE_MIC=1) drives the live mic recognizer while `say` plays into the
    default input — pair with a BlackHole input for a reliable digital loopback. Needs
    a one-time Speech (and, for MIC, Microphone) grant; reports clearly if ungranted. */
int runVoiceSmoke (MoshEngine&, MoshOps&);

/** Headless deep plugin scan (`Mosh --scan-plugins-deep`): a synchronous out-of-
    process VST3 + AudioUnit catalog sweep with the hang-watchdog engaged, then
    prints the catalog + the quarantine list. Returns 0 on success. */
int runDeepPluginScan (MoshOps&);

/** Scripted Stage 3 demo (`Mosh --demo3`): builds a session with a VST3 effect on
    a wave track and a VST3 synth on a MIDI track, and opens the synth's native
    editor — then leaves the GUI running (for visual verification of the gate). */
void runPluginDemo (MoshOps&);

/** Scripted Stage 5 demo (`Mosh --demo5`): a track + tone + a generative
    RenderLayer with a completed FakeAdapter render — for visual verification of
    the generative drawer (audition/accept/reject). */
void runGenerativeDemo (MoshOps&);

/** Scripted Stage 6 demo (`Mosh --demo6`): a consolidated session — a track with
    a Tier-A neural insert AND a Tier-B generative RenderLayer — for the final
    full-loop screenshot. (Does not render; that needs the service.) */
void runConsolidationDemo (MoshOps&);

} // namespace mosh
