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

/** Scripted Stage 3 demo (`Mosh --demo3`): builds a session with a VST3 effect on
    a wave track and a VST3 synth on a MIDI track, and opens the synth's native
    editor — then leaves the GUI running (for visual verification of the gate). */
void runPluginDemo (MoshOps&);

/** Scripted Stage 4 demo (`Mosh --demo4`): a track + tone + a Tier-A neural
    insert with the drive driven up — for visual verification of the neural rack. */
void runNeuralDemo (MoshOps&);

} // namespace mosh
