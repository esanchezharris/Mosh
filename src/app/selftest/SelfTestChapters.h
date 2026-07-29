#pragma once

// ── SelfTest chapter TUs (RFC 002 — selftest chapter split, A-PR5) ─────────────
// runSelfTest's leading run of sections (Stage 1 .. MON-003, ~50% of the section
// sequence) moved verbatim into per-chapter TUs under src/app/selftest/. Each
// chapter is a leading-prefix slice cut ONLY at section() starts, in exact
// pre-split order; runSelfTest calls them in sequence and then continues with
// the untouched inline remainder.

#include <juce_core/juce_core.h>

namespace mosh
{
namespace selftest { struct SelfTestCtx; }

void runChapter01_commands_arrangement    (selftest::SelfTestCtx& ctx);
void runChapter02_hosting_session_editing (selftest::SelfTestCtx& ctx);
void runChapter03_automation_plugins_master (selftest::SelfTestCtx& ctx);
void runChapter04_generative_layer        (selftest::SelfTestCtx& ctx);
void runChapter05_export_drums_recording  (selftest::SelfTestCtx& ctx);

// The harness hosts a REAL external plugin to exercise VST3 hosting, but it must NEVER
// host an arbitrary user-installed plugin. Many installed plugins destabilise the HOST
// itself (not merely themselves) on teardown, aborting the whole Mosh process:
//   • a cracked/badly-behaved VST3 spawns a background thread that outlives its instance
//     and locks an already-freed std::mutex -> EINVAL -> uncaught std::system_error
//     (observed: SIR Audio Tools "StandardCLIP" / its QueueControlThread);
//   • a stock Apple AudioUnit leaves a CoreAudio CAEventReceiver timer whose std::function
//     is cleared on teardown -> bad_function_call when the timer next fires during a
//     message-loop pump (observed: AUSampler / AUVectorPanner).
// The scanned-catalog order is not even stable run-to-run, so "the first installed effect"
// was a different plugin each run -> a ~50% crash. (Root-caused 2026-06-18.) Rather than
// blocklist each crasher (whack-a-mole), POSITIVELY allow only VST3s from a small set of
// vendors verified to load + tear down cleanly. AudioUnits are excluded wholesale (their
// teardown race is format-level). Extend the allowlist as more vendors are verified; an
// unknown/cracked vendor is never hosted (the section then skips gracefully, like the
// no-plugins-installed path).
// (Moved verbatim from SelfTest.cpp in A-PR5: it is now called from three chapter TUs.)
inline bool isHarnessHostablePlugin (const juce::var& p)
{
    if (p.getProperty ("format", juce::var()).toString() != "VST3")
        return false;
    const auto m = p.getProperty ("manufacturer", juce::var()).toString();
    return m == "Xfer Records"          // Serum 2 / Serum 2 FX / OTT
        || m == "Vital Audio"           // Vital
        || m == "Valhalla DSP, LLC";    // ValhallaVintageVerb / Room / UberMod / ...
}

} // namespace mosh
