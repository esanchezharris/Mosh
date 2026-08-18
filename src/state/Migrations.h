#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include <functional>
#include <vector>
#include "state/Ids.h"

// PRJ-FMT — project FORMAT versioning + forward migration + newer-file refusal.
//
// Mosh embeds its own ValueTree state in the Tracktion .tracktionedit (MOSH_PROJECT /
// MOSH_RENDERLAYER / MOSH_SECTIONS / MOSH_ANNOTATIONS + per-track Mosh props). The day
// that schema changes, every project saved by an older build is at risk. This header is
// the single hook that makes such changes safe: a version stamp written on every save, a
// forward-migration registry applied on open, and a graceful refusal when a file was made
// by a NEWER Mosh than this build.
//
// Header-only + engine-free (juce_data_structures only) so it unit-tests in MoshTests with
// zero engine dependency, mirroring state/RenderLayer.h.
namespace mosh
{
    // BUMP this whenever a breaking/forward-incompatible change to a Mosh-owned node ships
    // (a renamed/removed property, a restructured MOSH_* node, a changed default an old
    // reader would misread). Adding a NEW optional property with a safe absent-default does
    // NOT require a bump. Every bump MUST add a matching migration step vN→v(N+1) to
    // migrations() below, or the registry-contiguity invariant (asserted + unit-tested) fails.
    inline constexpr int kMoshFormatVersion = 1;

    // The C++→UI snapshot WIRE-CONTRACT version — a DIFFERENT concern from the file format:
    // file-format mismatch = refuse-to-open; snapshot mismatch = advise-to-update (the UI
    // keeps running, degraded). Bump when a snapshot field is removed/retyped such that an
    // older UI build would mis-read it. Mirrored in ui/src/types.ts (EXPECTED_SNAPSHOT_SCHEMA).
    inline constexpr int kSnapshotSchemaVersion = 1;

    struct MigrationResult
    {
        bool         ok = true;       // false ⇒ refused (file newer than this build)
        int          fromVersion = 0; // version read off the file (absent ⇒ 0/legacy)
        int          toVersion = 0;   // version after migration (== kMoshFormatVersion on success)
        juce::String error;           // user-facing message when !ok
    };

    struct MigrationStep
    {
        int         from;             // applies when the running version == from
        int         to;               // == from + 1
        const char* name;             // for logging / diagnostics
        std::function<void (juce::ValueTree& editState)> apply;  // pure mutation of Mosh-owned nodes
    };

    namespace detail
    {
        // Find (or create, non-undoably) the MOSH_PROJECT child — mirrors
        // MoshOps::projectSettingsTree() so the stamp lives next to the other project intent.
        inline juce::ValueTree ensureProjectNode (juce::ValueTree& editState)
        {
            auto node = editState.getChildWithName (ids::MOSH_PROJECT);
            if (! node.isValid())
            {
                node = juce::ValueTree (ids::MOSH_PROJECT);
                editState.appendChild (node, nullptr);   // nullptr ⇒ not undoable (a preference/stamp)
            }
            return node;
        }
    }

    // Ordered, contiguous v(N)→v(N+1). v1 has no REAL migrations yet — this is the wired
    // scaffold + ONE illustrative step that proves the hook fires (v0 ⇒ a pre-versioning file
    // with no MOSH_PROJECT stamp; the step just ensures the node exists). When a real breaking
    // change ships, bump kMoshFormatVersion and append { N, N+1, "...", fn }.
    inline const std::vector<MigrationStep>& migrations()
    {
        static const std::vector<MigrationStep> steps = {
            { 0, 1, "v0->v1: ensure MOSH_PROJECT exists",
              [] (juce::ValueTree& st) { detail::ensureProjectNode (st); } },
        };
        return steps;
    }

    // Read the stamped format version. Absent ⇒ 0 (pre-versioning legacy / brand-new edit).
    inline int readFileVersion (const juce::ValueTree& editState)
    {
        auto p = editState.getChildWithName (ids::MOSH_PROJECT);
        return (p.isValid() && p.hasProperty (ids::moshFormatVersion))
                   ? (int) p.getProperty (ids::moshFormatVersion) : 0;
    }

    // Stamp the CURRENT format version onto MOSH_PROJECT. Called on every save so on-disk
    // files are always current; idempotent.
    inline void stampFormatVersion (juce::ValueTree editState)
    {
        auto node = detail::ensureProjectNode (editState);
        node.setProperty (ids::moshFormatVersion, kMoshFormatVersion, nullptr);
    }

    namespace detail
    {
        // Core chain-walk, parameterized over (targetVersion, steps) so it can be exercised
        // with a SYNTHETIC registry in tests — proving the walk applies N>1 hops in order and
        // refuses gracefully (not jassert-only) on a broken chain — without touching the REAL
        // kMoshFormatVersion/migrations(), which must stay tied to the actual shipped schema.
        // No stamping here (that's a migrateOrRefuse-only concern, tied to the real version).
        inline MigrationResult migrateOrRefuseImpl (juce::ValueTree editState, int targetVersion,
                                                     const std::vector<MigrationStep>& steps)
        {
            const int fileV = readFileVersion (editState);
            MigrationResult r; r.fromVersion = fileV; r.toVersion = fileV;

            if (fileV > targetVersion)
            {
                r.ok = false;
                r.error = "This project (format v" + juce::String (fileV)
                        + ") was made by a newer version of Mosh than this build (v"
                        + juce::String (targetVersion) + "). Please update Mosh to open it.";
                return r;
            }

            int cur = fileV;
            while (cur < targetVersion)
            {
                const MigrationStep* step = nullptr;
                for (auto& s : steps)
                    if (s.from == cur) { step = &s; break; }

                jassert (step != nullptr);   // contiguous-chain invariant (also unit-tested)
                if (step == nullptr)
                {
                    r.ok = false;
                    r.error = "Missing migration step from format v" + juce::String (cur);
                    return r;
                }
                step->apply (editState);
                cur = step->to;
            }

            r.toVersion = cur;
            return r;
        }
    }

    // The load-time gate. Apply to a freshly-loaded Edit's `state` BEFORE the engine starts
    // using it (before wireEditResolvers / any snapshot or command). Migrations mutate
    // editState in place (persisted on the next save); a refusal does NOT mutate.
    //
    // Forward-compat for ADDITIVE changes (the case multiplayer's new state fields will hit):
    // this gate does NOT need to widen. Per the kMoshFormatVersion contract above, a build
    // only bumps the version on a BREAKING change; a new optional property/child with a safe
    // absent-default is written WITHOUT a bump. So an older build opening a file with such an
    // extra, unmodeled property sees fileV == kMoshFormatVersion (equal-version, no-op success,
    // below) — the unknown data is never touched by this gate and survives untouched into the
    // live ValueTree (proven by the "unknown-but-present property survives" test in
    // test_migrations.cpp). "Newer but compatible" is thus not a THIRD branch to add here —
    // it is architecturally the same case as "equal version" by construction, as long as that
    // discipline (bump only on breaking changes) holds.
    inline MigrationResult migrateOrRefuse (juce::ValueTree editState)
    {
        auto r = detail::migrateOrRefuseImpl (editState, kMoshFormatVersion, migrations());
        if (r.ok)
            stampFormatVersion (editState);  // now-current; persisted on the next save
        return r;
    }
}
