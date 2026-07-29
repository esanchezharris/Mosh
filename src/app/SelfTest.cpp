#include "SelfTest.h"
#include "selftest/SelfTestChapters.h"
#include "selftest/SelfTestSupport.h"
#include "engine/MoshEngine.h"
#include "engine/SessionPaths.h"
#include "moshops/MoshOps.h"
#include "moshops/AgentMemoryStore.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#include "state/Migrations.h"
#include "multiplayer/MultiplayerClient.h"
#include "multiplayer/MultiplayerSession.h"
#include "brain/BrainProxy.h"
#include "voice/NativeSpeech.h"
#include "util/Env.h"
#include <juce_cryptography/juce_cryptography.h>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <thread>
#include <vector>

namespace mosh
{
namespace
{
    // RFC 002 scaffolding: the harness plumbing + its file-static state moved to
    // selftest/SelfTestSupport.* (shared with selftest/SelfTest.Modes.cpp and the
    // upcoming chapter TUs). These thin shims keep the exact pre-split
    // free-function names and signatures so runSelfTest's ~8,500-line body below
    // stays byte-identical to its pre-split form (the RFC's transcript oracle
    // depends on the section bodies staying verbatim).
    selftest::SelfTestCtx& gCtx = selftest::globalCtx();
    int& failures = gCtx.failures;
    int& checks   = gCtx.checks;

    [[maybe_unused]] inline void finishSection()                             { selftest::finishSection (gCtx); }
    [[maybe_unused]] inline void resetSections()                             { selftest::resetSections (gCtx); }
    [[maybe_unused]] inline void section (const juce::String& name)          { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void section (const char* name)                  { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void check (bool cond, const juce::String& what) { selftest::check (gCtx, cond, what); }
    [[maybe_unused]] inline void check (bool cond, const char* what)         { selftest::check (gCtx, cond, what); }

    using selftest::cmd;
    using selftest::args1;
    using selftest::objN;
    using selftest::ok;
    using selftest::tracks;
    using selftest::firstTrack;
    using selftest::trackClips;
    using selftest::trackSnapshotByLogicalId;
    using selftest::selftestTempPath;
}

int runSelfTest (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    failures = 0; checks = 0;
    resetSections();
    // Pin the FAKE transform adapter for the deterministic selftest, regardless of whether
    // real RAVE models happen to be installed in RAVE_MODEL_DIR on this machine (the
    // spawned generative service inherits this env). The "Route B: transform (fake)"
    // section asserts the deterministic fake adapter; without this it would hit the real
    // RAVE backend if models are present and break. Mirrors how SA3 stays fake here. The
    // real transform path is covered separately by scripts/verify-hardware/verify.py --rave.
    mosh::setEnvVar ("MOSH_ENABLE_TRANSFORM", "0");
    // Same pin for the FMS sing adapter: a machine with MOSH_SOULX_SSH_HOST + an enrolled
    // voice configured must still run the deterministic fake legato-beep backend here.
    mosh::setEnvVar ("MOSH_ENABLE_SOULX", "0");
    // LoRA rack double lock: the fake path never consults the registry (names key the
    // fingerprint directly), but pin the kill switch AND an empty library dir anyway so
    // the user's real ~/Library/Mosh/loras can never leak into a hermetic run.
    mosh::setEnvVar ("MOSH_ENABLE_LORAS", "0");
    {
        auto emptyLoraDir = selftestTempPath (eng, "loras-empty");
        emptyLoraDir.createDirectory();
        mosh::setEnvVar ("MOSH_LORA_DIR", emptyLoraDir.getFullPathName().toRawUTF8());
    }
    if (SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SA3", "0") != "1")
        mosh::setEnvVar ("MOSH_ENABLE_SA3", "0");
    // AGT-MEM (Phase-B memory lane, M1) — pin the global agent-memory store INSIDE this
    // run's already-isolated session dir (SLF-CONC-001) so a plain `--selftest` never
    // touches the owner's real ~/Library/Mosh/agent, and two concurrent runs on this
    // host can't collide on the same JSONL files.
    mosh::setEnvVar ("MOSH_AGENT_DIR", eng.sessionDir().getChildFile ("agent").getFullPathName().toRawUTF8());
    std::cerr << "\n===== Mosh Stage 1 command-surface harness =====\n";
    // The session dir is now per-process by default, so name it: this run's exports,
    // saved edit and mosh-log.jsonl live HERE, not in a shared fixed path.
    std::cerr << "session dir: " << eng.sessionDir().getFullPathName() << "\n";
    // ── RFC 002 A-PR5 + A-PR6: the WHOLE section sequence now lives in per-chapter
    // TUs under src/app/selftest/ (A-PR5 moved 1-5, A-PR6 the remainder as 6-11).
    // gCtx is the same instance the shims above bind to, so counters and section
    // timing continue seamlessly across every seam. runSelfTest is the spine: the
    // prelude above, these calls, and the tally/return epilogue below.
    gCtx.eng = &eng;
    gCtx.ops = &ops;
    runChapter01_commands_arrangement (gCtx);
    runChapter02_hosting_session_editing (gCtx);
    runChapter03_automation_plugins_master (gCtx);
    runChapter04_generative_layer (gCtx);
    runChapter05_export_drums_recording (gCtx);
    runChapter06_settings_project_safety (gCtx);
    runChapter07_project_meta_recovery (gCtx);
    runChapter08_arrangement_editing_routing (gCtx);
    runChapter09_tempo_warp_brain (gCtx);
    runChapter10_multiplayer (gCtx);
    runChapter11_sections_memory_matrix (gCtx);

    finishSection();
    std::cerr << "===== " << (checks - failures) << "/" << checks
              << " checks passed, " << failures << " failed =====\n\n";
    return failures;
}

} // namespace mosh
