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

/** Opens the real audio device path, plays a deterministic tone briefly, and
    exits. Used by the BlackHole virtual loopback gate. */
int runLiveAudioSmoke (MoshEngine&, MoshOps&);

/** Diagnostic (`Mosh --scan-plugins-deep`): runs a synchronous deep plugin scan
    (out-of-process VST3 + in-process AudioUnit), then prints the resulting catalog
    (count, names, formats) and blocklist to stderr. Rebuilds the persisted catalog
    the GUI app reads. Returns 0 on success. */
int runDeepPluginScan (MoshOps&);

/** Scripted Stage 3 demo (`Mosh --demo3`): builds a session with a VST3 effect on
    a wave track and a VST3 synth on a MIDI track, and opens the synth's native
    editor — then leaves the GUI running (for visual verification of the gate). */
void runPluginDemo (MoshOps&);

/** Scripted Stage 4 demo (`Mosh --demo4`): a track + tone + a Tier-A neural
    insert with the drive driven up — for visual verification of the neural rack. */
void runNeuralDemo (MoshOps&);

/** Scripted Stage 5 demo (`Mosh --demo5`): a track + tone + a generative
    RenderLayer with a completed FakeAdapter render — for visual verification of
    the generative drawer (audition/accept/reject). */
void runGenerativeDemo (MoshOps&);

/** Scripted Stage 6 demo (`Mosh --demo6`): a consolidated session — a track with
    a Tier-A neural insert AND a Tier-B generative RenderLayer — for the final
    full-loop screenshot. (Does not render; that needs the service.) */
void runConsolidationDemo (MoshOps&);

} // namespace mosh
