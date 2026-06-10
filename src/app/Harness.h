#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
class MoshEngine;
class MoshOps;

/** The headless replay harness (phase0 §4):

      Mosh --harness job.json [--harness-out result.json]

    job.json = { "ops": [MoshIR...], "tutorialId"?, "state_before"?: edit-path,
                 "bounce"?: bool, "timeout_s"?: number (default 120) }

    Executes the ops through execute_ir (the one mutation path), then reports
    { ok, state_hash, counts, results, bounce? {file, md5} } — written to the
    result file (default: <job>.result.json) and echoed to stdout on a line
    prefixed MOSH_HARNESS_RESULT. Exit code: 0 = all ops executed (Unsupported
    is a finding, not a failure), 1 = op failures, 2 = bad job, 124 = timeout
    (a watchdog enforces the cap — structured failure, never a hang).

    Batch mode = N parallel app instances, each with its own MOSH_SESSION_DIR
    (the engine honors the override); see scripts/harness-conformance.sh. */
int runHarness (MoshEngine& engine, MoshOps& ops, const juce::String& commandLine);

} // namespace mosh
