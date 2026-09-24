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

/** CAP-001 — `Mosh --record-hold-smoke`: run 1 of the crash-residue test. Creates and
    saves a named project, arms a track on the live input, starts recording, prints one
    "RECORD-HOLD: recording ..." line naming the edit file, and then holds the message
    loop until the process is KILLED (that is the test: tests/crash-residue-smoke.sh
    sends SIGKILL mid-take, then relaunches headless and asserts the take is offered and
    adoptable). Writes the liveness sentinel exactly as the GUI does, so the relaunch
    reads as unclean. Never returns on its own. */
int runRecordHoldSmoke (MoshEngine&, MoshOps&);
/** LAT-001 — `Mosh --latency-calibration-smoke`: the measured-latency path end to end
    through a loopback device, with nobody at the mic. Pair MOSH_AUDIO_OUTPUT_DEVICE and
    MOSH_AUDIO_INPUT_DEVICE with "BlackHole 2ch" so the sweep the calibration plays comes
    straight back as input. Asserts a measurement lands (never a silent number), that
    its residual is applied, and - the part that matters - that a click played at 1.0 s
    and recorded through the same loopback lands within 1 ms of 1.0 s. Its own mode
    because it needs a real device; proves nothing about AUDIBILITY (that is
    --live-audio-smoke's job). */
int runLatencyCalibrationSmoke (MoshEngine&, MoshOps&);

/** V3-vocal — `Mosh --v3-vocal-smoke`: the Booth's recording loop (docs/PHONE_PAD.md) with a
    REAL audio device and nobody at the mic. Pair MOSH_AUDIO_OUTPUT_DEVICE and
    MOSH_AUDIO_INPUT_DEVICE with "BlackHole 2ch": a guide tone the engine plays comes straight
    back as the "voice". Calibrates the loopback first (LAT-001), then: count-in 1 bar,
    loop_record from bar 3, stop; loop_again (restarts capture live), stop; loop_keep; undo.
    Asserts the count-in rolled and was EXCLUDED from the landed take (the take starts at the
    entry point and its first onset is the tone played after it, not the one during the
    pre-roll), both passes are non-silent WAVs on disk landing within the calibrated
    tolerance, Again mutes and rejects, Keep moves the pass to LEAD audible, and undo reverses
    the keep. Prints one "V3-VOCAL-SMOKE: {json}" line for scripts/v3-acceptance/run.py.
    Proves nothing about AUDIBILITY or feel — those stay with the owner. */
int runV3VocalSmoke (MoshEngine&, MoshOps&);

/** Chords stress — `Mosh --chords-stress`: the V3 '+ Chords' batch, create_track, a 4OSC
    insert, a load_preset and an add_send (on a persistent bus), each followed by undo,
    looped with a REAL device (pair with MOSH_AUDIO_{OUTPUT,INPUT}_DEVICE="BlackHole 2ch"),
    every track metered and the 30 Hz telemetry live, the transport rolling. The regression
    smoke for the 2026-09-23 heap corruption (an undo that removed a metered track; the
    'send' variant is the sibling case, an undo that removed a metered send). Run it in an
    ASan build to name any stray write; MOSH_CHORDS_STRESS_ITERS / _VARIANTS / _SETTLE_MS
    tune it. Prints one "CHORDS-STRESS: {json}" line. */
int runChordsStress (MoshEngine&, MoshOps&);

/** Direct Re-Imagine audio smoke -- `Mosh --direct-reimagine-audio-smoke`: FINDINGS.md #7
    follow-up (2026-09-24). Reproduces the exact sequence from the real walkthrough's
    mosh-log.jsonl with a REAL device (pair with MOSH_AUDIO_{OUTPUT,INPUT}_DEVICE="BlackHole
    2ch", like --chords-stress): create an explicit Direct Re-Imagine render layer (the
    deterministic fixture backend, no SA3 -- pair with MOSH_DIRECT_RENDER_TEST_FIXTURE=1 and
    MOSH_SERVICE_SCRIPT pointing at scripts/verify-hardware/direct_render_fixture_service.py),
    render, Keep, start playback, Source/Result audition, stop, undo. Asserts the undo
    reverts Keep specifically (not some other transaction the live playback graph opened),
    and that a prior unrelated edit survives. Prints one "DIRECT-REIMAGINE-AUDIO-SMOKE: {json}"
    line. */
int runDirectReimagineAudioSmoke (MoshEngine&, MoshOps&);

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
