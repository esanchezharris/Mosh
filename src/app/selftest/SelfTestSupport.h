#pragma once

// ── SelfTest harness plumbing (RFC 002 — selftest chapter split, scaffolding) ──
// The check/section/cmd helpers and their file-static state that used to live in
// the anonymous namespace at the top of src/app/SelfTest.cpp. Shared between
// SelfTest.cpp (runSelfTest), SelfTest.Modes.cpp (the self-contained CLI modes),
// and the upcoming chapter TUs. Bodies are verbatim from the pre-split file,
// reworked only to take SelfTestCtx& where they used the file-static counters.

#include <juce_core/juce_core.h>

#include <functional>
#include <initializer_list>
#include <utility>
#include <vector>

namespace mosh
{
class MoshEngine;
class MoshOps;

namespace selftest
{
    /** The harness state that used to be file-statics in SelfTest.cpp. Deliberately
        MINIMAL: only what the moved plumbing itself needs now — the chapter PRs
        (A-PR5/6) grow it as the compiler demands (the prefix-motion design). */
    struct SelfTestCtx
    {
        int failures = 0;
        int checks = 0;
        juce::String activeSection;
        double activeSectionStartedMs = 0.0;
        int activeSectionStartChecks = 0;
        int activeSectionStartFailures = 0;

        // ── A-PR5 (chapter motion) ────────────────────────────────────────────
        // runSelfTest's own parameters. Every moved section uses `eng`/`ops`, and
        // the RFC's chapter signature is runChapterNN(SelfTestCtx&) only — so the
        // chapters rebind these in their preamble (auto& eng = *ctx.eng; ...),
        // keeping the section bodies byte-verbatim. Set by runSelfTest before the
        // first chapter call.
        MoshEngine* eng = nullptr;
        MoshOps* ops = nullptr;

        // Cross-chapter locals, promoted EXACTLY as the compiler enumerated them
        // at the A-PR5 cut points (each was a runSelfTest local declared in one
        // chapter and read in a later chapter and/or the inline remainder; the
        // declaring chapter assigns it, every later consumer rebinds a reference
        // in its preamble so the section bodies stay byte-verbatim):
        std::vector<juce::String> eventTypes;                      // Ch01 event sink -> Ch02, Ch05, remainder
        juce::var lastEvent;                                       // Ch01 event sink -> remainder (scoped-invalidation payload)
        std::function<bool (const juce::String&)> hadEvent;        // Ch01 -> Ch05
        juce::String tid;                                          // Ch01 (Stage 2 track id) -> Ch02
        std::function<juce::var (const juce::String&)> trackById;  // Ch02 -> Ch03, Ch04, Ch05, remainder
    };

    /** The process-wide harness state. Every TU's shims bind to this one instance,
        so counter/section behaviour is exactly the pre-split file-static behaviour
        (one set of counters per process, reset by each entry point). */
    SelfTestCtx& globalCtx();

    void finishSection (SelfTestCtx& ctx);
    void resetSections (SelfTestCtx& ctx);
    void section (SelfTestCtx& ctx, const juce::String& name);
    void section (SelfTestCtx& ctx, const char* name);
    void check (SelfTestCtx& ctx, bool cond, const juce::String& what);
    void check (SelfTestCtx& ctx, bool cond, const char* what);

    juce::var cmd (MoshOps& ops, const juce::String& name, juce::var args = juce::var());
    juce::var args1 (const char* k, juce::var v);
    juce::var objN (std::initializer_list<std::pair<const char*, juce::var>> kv);
    bool ok (const juce::var& r);
    int tracks (MoshOps& ops);
    juce::var firstTrack (MoshOps& ops);
    int trackClips (const juce::var& t);
    juce::var trackSnapshotByLogicalId (MoshOps& ops, const juce::String& logicalId);
    juce::File selftestTempPath (const MoshEngine& eng, const juce::String& leafName);

} // namespace selftest
} // namespace mosh
