#include <catch2/catch_test_macros.hpp>
#include "moshops/AgentTxn.h"
#include "moshops/TransactionSafe.h"

using namespace juce;
namespace tx = mosh::agenttxn;

// FS-B2a — the ENGINE-FREE half of the batch-transaction contract. Everything here runs
// with no Tracktion engine and no session on disk, which is the only honest way to prove
// the restart / needs_recovery path: JUCE ignores $HOME, so a harness run always hits the
// REAL ~/Library/Mosh and there is no sandbox to crash inside.
//
// The engine-coupled half (undo-head ownership, exact rollback, the executeImpl guard)
// is proven by the --selftest TXN-* sections against a real Edit.

namespace
{
    var obj (std::initializer_list<std::pair<const char*, var>> kv)
    {
        auto* o = new DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return var (o);
    }

    var arr (std::initializer_list<var> items)
    {
        Array<var> a;
        for (auto& i : items) a.add (i);
        return var (a);
    }

    /** A snapshot shaped like the real one: a song part (tracks/session.tempo) and a
        volatile part (transport/session.dirty/session.audioDeviceName). */
    var snapshotFixture (double volumeDb, double transportPosition, bool dirty)
    {
        return obj ({
            { "schemaVersion", 7 },
            { "session", obj ({ { "tempo", 120.0 },
                                { "metronome", false },
                                { "dirty", dirty },
                                { "audioDeviceName", String ("Some Interface") },
                                { "editFile", String ("/Users/someone/Library/Mosh/session/a.tracktionedit") } }) },
            { "tracks", arr ({ obj ({ { "id", String ("t1") }, { "name", String ("Drums") },
                                      { "volumeDb", volumeDb } }) }) },
            { "transport", obj ({ { "position", transportPosition }, { "playing", false } }) },
        });
    }

    var manifestOf (std::initializer_list<std::pair<const char*, const char*>> idAndCommand)
    {
        Array<var> a;
        int i = 0;
        for (auto& p : idAndCommand)
            a.add (obj ({ { "index", i++ }, { "requestId", String (p.first) },
                          { "command", String (p.second) } }));
        return var (a);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical fingerprint
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE ("fingerprint: identical snapshots agree, key order does not matter", "[agenttxn]")
{
    const auto a = snapshotFixture (-6.0, 0.0, false);
    const auto b = snapshotFixture (-6.0, 0.0, false);
    REQUIRE (tx::fingerprint (a) == tx::fingerprint (b));

    // Same content, DIFFERENT insertion order — the canonicalizer sorts keys, so a
    // snapshot rebuilt after an undo (which need not preserve property order) still
    // matches its pre-state.
    auto* reordered = new DynamicObject();
    reordered->setProperty ("tracks", a.getProperty ("tracks", var()));
    reordered->setProperty ("transport", a.getProperty ("transport", var()));
    reordered->setProperty ("session", a.getProperty ("session", var()));
    reordered->setProperty ("schemaVersion", a.getProperty ("schemaVersion", var()));
    REQUIRE (tx::fingerprint (var (reordered)) == tx::fingerprint (a));
}

TEST_CASE ("fingerprint: SENSITIVE to a real edit — this is the anti-vacuity leg", "[agenttxn]")
{
    // A fingerprint that excluded too much would sail through the volatile test below
    // and quietly accept an incomplete rollback. So: one property of one track.
    REQUIRE (tx::fingerprint (snapshotFixture (-6.0, 0.0, false))
             != tx::fingerprint (snapshotFixture (-6.5, 0.0, false)));

    // …and to song-level state, an added track, and a removed one.
    auto tempoChanged = snapshotFixture (-6.0, 0.0, false);
    tempoChanged.getDynamicObject()->getProperty ("session")
        .getDynamicObject()->setProperty ("tempo", 121.0);
    REQUIRE (tx::fingerprint (tempoChanged) != tx::fingerprint (snapshotFixture (-6.0, 0.0, false)));

    auto extraTrack = snapshotFixture (-6.0, 0.0, false);
    {
        auto tracks = extraTrack.getProperty ("tracks", var());
        auto* a = tracks.getArray();
        REQUIRE (a != nullptr);
        a->add (obj ({ { "id", String ("t2") }, { "name", String ("Bass") }, { "volumeDb", 0.0 } }));
    }
    REQUIRE (tx::fingerprint (extraTrack) != tx::fingerprint (snapshotFixture (-6.0, 0.0, false)));
}

TEST_CASE ("fingerprint: STABLE across declared volatile change", "[agenttxn]")
{
    // A transport seek, a dirty flag flip, and a device rename must not move the
    // fingerprint — otherwise no rollback could ever verify (markDirty() is one-way).
    const auto base = snapshotFixture (-6.0, 0.0, false);
    REQUIRE (tx::fingerprint (snapshotFixture (-6.0, 12.5, true)) == tx::fingerprint (base));

    auto renamedDevice = snapshotFixture (-6.0, 0.0, false);
    renamedDevice.getDynamicObject()->getProperty ("session")
        .getDynamicObject()->setProperty ("audioDeviceName", "Another Interface");
    REQUIRE (tx::fingerprint (renamedDevice) == tx::fingerprint (base));
}

TEST_CASE ("fingerprint: the volatile declaration excludes only leaves it names", "[agenttxn]")
{
    // Guards the dot-path semantics: "session.dirty" must not also swallow "session",
    // and a path that names no real key must not silently match everything.
    REQUIRE (tx::isVolatilePath ("session.dirty"));
    REQUIRE_FALSE (tx::isVolatilePath ("session"));
    REQUIRE_FALSE (tx::isVolatilePath ("tracks"));
    REQUIRE_FALSE (tx::isVolatilePath ("session.tempo"));
    REQUIRE (tx::isVolatilePath ("transport"));

    // And the canonical form of a real snapshot still CONTAINS the song. If a future
    // volatile entry ever swallowed the arrangement, this fails.
    const auto canon = tx::canonicalize (snapshotFixture (-6.0, 0.0, false), true);
    REQUIRE (canon.contains ("\"tracks\""));
    REQUIRE (canon.contains ("\"volumeDb\""));
    REQUIRE (canon.contains ("\"tempo\""));
    REQUIRE_FALSE (canon.contains ("\"transport\""));
    REQUIRE_FALSE (canon.contains ("\"dirty\""));
    // A home path is volatile AND privacy-relevant; it must not reach the digest input.
    REQUIRE_FALSE (canon.contains ("/Users/"));
}

TEST_CASE ("canonicalize: scalar forms are deterministic and type-distinct", "[agenttxn]")
{
    REQUIRE (tx::canonicalize (var (1), false)     == "1");
    REQUIRE (tx::canonicalize (var (true), false)  == "true");
    REQUIRE (tx::canonicalize (var (false), false) == "false");
    REQUIRE (tx::canonicalize (var(), false)       == "null");
    // Fixed 9-decimal doubles: precise enough for dB/seconds, immune to last-bit noise.
    REQUIRE (tx::canonicalize (var (1.5), false)   == "1.500000000");
    // "1" the string must not collide with 1 the int.
    REQUIRE (tx::canonicalize (var (String ("1")), false) != tx::canonicalize (var (1), false));
    // Arrays are ordered; objects are not.
    REQUIRE (tx::canonicalize (arr ({ var (1), var (2) }), false)
             != tx::canonicalize (arr ({ var (2), var (1) }), false));
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE ("parseManifest: accepts a well-formed manifest", "[agenttxn]")
{
    std::vector<tx::ManifestEntry> entries;
    String error;
    REQUIRE (tx::parseManifest (manifestOf ({ { "r0", "set_track_volume" },
                                              { "r1", "set_track_mute" } }), entries, error));
    REQUIRE (error.isEmpty());
    REQUIRE (entries.size() == 2);
    REQUIRE (entries[0].index == 0);
    REQUIRE (entries[0].requestId == "r0");
    REQUIRE (entries[1].command == "set_track_mute");
}

TEST_CASE ("parseManifest: rejects every malformed shape, before any registry lookup", "[agenttxn]")
{
    std::vector<tx::ManifestEntry> entries;
    String error;

    REQUIRE_FALSE (tx::parseManifest (var(), entries, error));
    REQUIRE (error.contains ("must be an array"));

    REQUIRE_FALSE (tx::parseManifest (var (Array<var>()), entries, error));
    REQUIRE (error.contains ("empty"));

    REQUIRE_FALSE (tx::parseManifest (arr ({ var (7) }), entries, error));
    REQUIRE (error.contains ("not an object"));

    REQUIRE_FALSE (tx::parseManifest (arr ({ obj ({ { "index", 0 }, { "command", String ("set_track_mute") } }) }),
                                      entries, error));
    REQUIRE (error.contains ("no 'requestId'"));

    REQUIRE_FALSE (tx::parseManifest (arr ({ obj ({ { "index", 0 }, { "requestId", String ("r0") } }) }),
                                      entries, error));
    REQUIRE (error.contains ("no 'command'"));

    // Out-of-order / wrong index.
    REQUIRE_FALSE (tx::parseManifest (arr ({ obj ({ { "index", 1 }, { "requestId", String ("r0") },
                                                    { "command", String ("set_track_mute") } }) }),
                                      entries, error));
    REQUIRE (error.contains ("declares index 1"));

    // A duplicate requestId inside ONE manifest would make replay ambiguous.
    REQUIRE_FALSE (tx::parseManifest (arr ({ obj ({ { "index", 0 }, { "requestId", String ("same") },
                                                    { "command", String ("set_track_mute") } }),
                                             obj ({ { "index", 1 }, { "requestId", String ("same") },
                                                    { "command", String ("set_track_volume") } }) }),
                                      entries, error));
    REQUIRE (error.contains ("reuses requestId"));
}

TEST_CASE ("manifestDigest: identity is skill name + every (index, requestId, command)", "[agenttxn]")
{
    std::vector<tx::ManifestEntry> a, b;
    String error;
    REQUIRE (tx::parseManifest (manifestOf ({ { "r0", "set_track_volume" }, { "r1", "set_track_mute" } }), a, error));
    REQUIRE (tx::parseManifest (manifestOf ({ { "r0", "set_track_volume" }, { "r1", "set_track_mute" } }), b, error));

    // Identical ⇒ a retried batch_begin is idempotent.
    REQUIRE (tx::manifestDigest ("set_track_level", a) == tx::manifestDigest ("set_track_level", b));
    // Different skill name, different command, different request id, different length —
    // each must be a DIFFERENT identity, so reusing an id with new metadata fails closed.
    REQUIRE (tx::manifestDigest ("other_skill", a) != tx::manifestDigest ("set_track_level", a));

    std::vector<tx::ManifestEntry> swappedCommand;
    REQUIRE (tx::parseManifest (manifestOf ({ { "r0", "set_track_volume" }, { "r1", "set_track_pan" } }),
                                swappedCommand, error));
    REQUIRE (tx::manifestDigest ("set_track_level", swappedCommand) != tx::manifestDigest ("set_track_level", a));

    std::vector<tx::ManifestEntry> newId;
    REQUIRE (tx::parseManifest (manifestOf ({ { "r0", "set_track_volume" }, { "rX", "set_track_mute" } }), newId, error));
    REQUIRE (tx::manifestDigest ("set_track_level", newId) != tx::manifestDigest ("set_track_level", a));

    std::vector<tx::ManifestEntry> shorter;
    REQUIRE (tx::parseManifest (manifestOf ({ { "r0", "set_track_volume" } }), shorter, error));
    REQUIRE (tx::manifestDigest ("set_track_level", shorter) != tx::manifestDigest ("set_track_level", a));
}

TEST_CASE ("digestOf: an envelope's identity covers its args", "[agenttxn]")
{
    const auto base = obj ({ { "command", String ("set_track_volume") },
                             { "args", obj ({ { "trackId", String ("t1") }, { "db", -6.0 } }) } });
    const auto same = obj ({ { "args", obj ({ { "db", -6.0 }, { "trackId", String ("t1") } }) },
                             { "command", String ("set_track_volume") } });
    const auto different = obj ({ { "command", String ("set_track_volume") },
                                  { "args", obj ({ { "trackId", String ("t1") }, { "db", -6.5 } }) } });

    // Key order is not identity; VALUES are. So a retry of the same call replays, and a
    // retry that quietly changed an argument is rejected instead of double-applying.
    REQUIRE (tx::digestOf (base) == tx::digestOf (same));
    REQUIRE (tx::digestOf (base) != tx::digestOf (different));
}

// ─────────────────────────────────────────────────────────────────────────────
// The rollback decision
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE ("planRollback: the whole decision table, including the G14 empty case", "[agenttxn]")
{
    using P = tx::RollbackPlan;
    const String ours = tx::labelFor ("txn-1");

    // We own a non-empty head ⇒ undo exactly it.
    REQUIRE (tx::planRollback (1, ours, ours) == P::UndoOurs);
    REQUIRE (tx::planRollback (7, ours, ours) == P::UndoOurs);

    // THE G14 TRAP. Zero actions means our transaction has no ActionSet of its own
    // (beginNewTransaction is lazy), so undo() would reach back and destroy the PREVIOUS
    // edit. NothingToUndo must never collapse into UndoOurs — not even when the head NAME
    // happens to be ours, which it is here because the name survives with no actions.
    REQUIRE (tx::planRollback (0, ours, ours) == P::NothingToUndo);
    REQUIRE (tx::planRollback (0, "some earlier edit", ours) == P::NothingToUndo);
    REQUIRE (tx::planRollback (-1, ours, ours) == P::NothingToUndo);

    // Someone else owns the head ⇒ refuse, and undo NOTHING. Unreachable through the
    // public command seam (an open transaction refuses every untagged mutation), which is
    // exactly why the decision is tested here rather than only in the selftest.
    REQUIRE (tx::planRollback (1, "a human edit", ours) == P::RefuseForeignHead);
    REQUIRE (tx::planRollback (1, tx::labelFor ("a-different-txn"), ours) == P::RefuseForeignHead);
    REQUIRE (tx::planRollback (1, "", ours) == P::RefuseForeignHead);

    // The label is per-transaction, so two agent transactions never alias.
    REQUIRE (tx::labelFor ("a") != tx::labelFor ("b"));
    REQUIRE (tx::labelFor ("a").startsWith ("agent-txn:"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest accounting
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE ("Record: applied/failed accounting and requestId lookup", "[agenttxn]")
{
    tx::Record r;
    r.id = "txn-1";
    r.label = tx::labelFor ("txn-1");
    r.status = tx::statusOpen();
    for (auto* id : { "rq-a", "rq-b", "rq-c" })
    {
        tx::Entry e;
        e.requestId = id;
        e.command = "set_track_volume";
        r.entries.push_back (e);
    }

    REQUIRE (r.isOpen());
    REQUIRE (r.appliedCount() == 0);
    REQUIRE_FALSE (r.anyFailed());
    REQUIRE_FALSE (r.allResolved());
    REQUIRE (r.indexOfRequestId ("rq-b") == 1);
    REQUIRE (r.indexOfRequestId ("nope") == -1);
    REQUIRE (r.findByRequestId ("rq-c") != nullptr);
    REQUIRE (r.findByRequestId ("nope") == nullptr);

    r.entries[0].state = tx::entryApplied();
    r.entries[1].state = tx::entryApplied();
    r.nextIndex = 2;
    REQUIRE (r.appliedCount() == 2);
    REQUIRE_FALSE (r.allResolved());   // step 2 is still pending — commit must refuse

    r.entries[2].state = tx::entryFailed();
    r.nextIndex = 3;
    REQUIRE (r.allResolved());
    REQUIRE (r.anyFailed());           // …and now commit must refuse for a different reason
    REQUIRE (r.appliedCount() == 2);

    r.status = tx::statusCommitted();
    REQUIRE_FALSE (r.isOpen());
    r.status = tx::statusFailed();
    REQUIRE (r.isOpen());              // failed is still ROLLBACK-able
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger + restart detection
// ─────────────────────────────────────────────────────────────────────────────

namespace
{
    String line (const char* id, const String& status)
    {
        return JSON::toString (tx::makeLedgerRecord (id, "set_track_level", status, {},
                                                     42, "preFP", "curFP", 1, 2), true);
    }
}

TEST_CASE ("ledger: a record carries ids/status/outcome and NO args or home paths", "[agenttxn]")
{
    const auto record = tx::makeLedgerRecord ("txn-1", "set_track_level", tx::statusCommitted(),
                                              {}, 42, "preFP", "curFP", 2, 2);
    const auto text = JSON::toString (record, true);

    REQUIRE ((int) record.getProperty ("v", var (0)) == tx::kLedgerVersion);
    REQUIRE (record.getProperty ("transactionId", var()).toString() == "txn-1");
    REQUIRE (record.getProperty ("status", var()).toString() == "committed");
    REQUIRE ((int) record.getProperty ("applied", var (0)) == 2);
    // The contract forbids args and owner-home data in the ledger. Structural, not filtered:
    // makeLedgerRecord has no args parameter at all.
    REQUIRE_FALSE (text.contains ("\"args\""));
    REQUIRE_FALSE (text.contains ("/Users/"));
}

TEST_CASE ("unresolvedIdsIn: an id whose last record is non-terminal is unresolved", "[agenttxn]")
{
    // The fixture must actually CARRY an unresolved transaction, or "no unresolved ids"
    // is a vacuous pass.
    REQUIRE (tx::unresolvedIdsIn ({ line ("a", tx::statusOpen()) }) == StringArray { "a" });
    REQUIRE (tx::unresolvedIdsIn ({ line ("a", tx::statusFailed()) }) == StringArray { "a" });
    REQUIRE (tx::unresolvedIdsIn ({ line ("a", tx::statusNeedsRecovery()) }) == StringArray { "a" });

    // …and a resolved one is not.
    REQUIRE (tx::unresolvedIdsIn ({ line ("a", tx::statusOpen()),
                                    line ("a", tx::statusCommitted()) }).isEmpty());
    REQUIRE (tx::unresolvedIdsIn ({ line ("a", tx::statusOpen()),
                                    line ("a", tx::statusFailed()),
                                    line ("a", tx::statusRolledBack()) }).isEmpty());
}

TEST_CASE ("unresolvedIdsIn: interleaved ids resolve independently, in first-seen order", "[agenttxn]")
{
    const StringArray lines {
        line ("a", tx::statusOpen()),
        line ("b", tx::statusOpen()),
        line ("c", tx::statusOpen()),
        line ("a", tx::statusCommitted()),
        line ("c", tx::statusRolledBack()),
    };
    REQUIRE (tx::unresolvedIdsIn (lines) == StringArray { "b" });

    const StringArray twoOpen {
        line ("b", tx::statusOpen()),
        line ("a", tx::statusOpen()),
    };
    // First-seen order, so the report is stable run to run.
    REQUIRE (tx::unresolvedIdsIn (twoOpen) == StringArray { "b", "a" });
}

TEST_CASE ("unresolvedIdsIn: a torn final line leaves its id UNRESOLVED, not clean", "[agenttxn]")
{
    // This is the shape a crash actually leaves. Skipping the torn line must not lose the
    // earlier `open` record for the same id — calling a crash-interrupted edit clean is
    // exactly what fs-b2.md forbids.
    const auto torn = line ("a", tx::statusOpen()).dropLastCharacters (12);
    REQUIRE (tx::unresolvedIdsIn ({ line ("a", tx::statusOpen()), torn }) == StringArray { "a" });

    // Junk, blanks and a wrong-version record are skipped without derailing the rest.
    REQUIRE (tx::unresolvedIdsIn ({ "", "   ", "not json at all",
                                    "{\"v\":999,\"transactionId\":\"z\",\"status\":\"open\"}",
                                    line ("a", tx::statusOpen()) }) == StringArray { "a" });

    // An entirely unreadable ledger reports nothing unresolved — MoshOps treats THAT as
    // ledger_unreadable rather than as proof of cleanliness (see the TXN-HEAD selftest).
    REQUIRE (tx::unresolvedIdsIn ({ "garbage" }).isEmpty());
}

TEST_CASE ("isTerminalStatus: only committed and rolled_back are finished", "[agenttxn]")
{
    REQUIRE (tx::isTerminalStatus (tx::statusCommitted()));
    REQUIRE (tx::isTerminalStatus (tx::statusRolledBack()));
    REQUIRE_FALSE (tx::isTerminalStatus (tx::statusOpen()));
    REQUIRE_FALSE (tx::isTerminalStatus (tx::statusFailed()));
    REQUIRE_FALSE (tx::isTerminalStatus (tx::statusNeedsRecovery()));
}

// ─────────────────────────────────────────────────────────────────────────────
// transactionSafe registry
// ─────────────────────────────────────────────────────────────────────────────

TEST_CASE ("txnsafe: the registry admits the transactable skills' commands", "[agenttxn]")
{
    for (auto* c : { "set_track_volume", "set_track_mute",           // set_track_level
                     "add_drum_pattern",                            // build_drum_pattern
                     "load_plugin", "set_plugin_param", "bypass_plugin",   // host_plugin
                     "promote_take_region",                       // assemble a playlist comp phrase
                     "set_track_automation_mode", "write_automation_curve", // automate_parameter
                     "create_lyric_sheet", "set_lyric_line", "set_lyric_constraint" })
        REQUIRE (mosh::txnsafe::isSafe (c));

    // A non-empty registry with a sane floor — a registry that emptied itself would make
    // every rejection test below vacuously green.
    REQUIRE (mosh::txnsafe::registry().size() >= 40);
}

TEST_CASE ("txnsafe: every rejection class refuses with a legible reason", "[agenttxn]")
{
    using mosh::txnsafe::Class;
    String reason;

    // Non-undoable preference — the exact reason arrange_beat cannot be transactional.
    REQUIRE (mosh::txnsafe::classify ("set_metronome", reason) == Class::NonUndoable);
    REQUIRE (reason.contains ("set_metronome"));
    REQUIRE (reason.isNotEmpty());

    // Async — the exact reason reimagine_clip cannot be transactional.
    REQUIRE (mosh::txnsafe::classify ("render_layer", reason) == Class::Async);
    REQUIRE (reason.contains ("asynchronously"));

    // A pure analysis/read is classified Async too (it spawns the service).
    REQUIRE (mosh::txnsafe::classify ("detect_clip_bpm", reason) == Class::Async);

    REQUIRE (mosh::txnsafe::classify ("open_project", reason) == Class::Lifecycle);
    REQUIRE (mosh::txnsafe::classify ("undo", reason) == Class::Lifecycle);
    REQUIRE (mosh::txnsafe::classify ("save", reason) == Class::Lifecycle);

    REQUIRE (mosh::txnsafe::classify ("batch_begin", reason) == Class::Nested);
    REQUIRE (mosh::txnsafe::classify ("batch_rollback", reason) == Class::Nested);
    REQUIRE (reason.contains ("boundary"));

    // FAIL-CLOSED: an unknown name is refused, not admitted.
    REQUIRE (mosh::txnsafe::classify ("no_such_command_at_all", reason) == Class::Unknown);
    REQUIRE (reason.contains ("transactionSafe registry"));
    REQUIRE_FALSE (mosh::txnsafe::isSafe ("no_such_command_at_all"));
}

TEST_CASE ("txnsafe: the reviewed exclusions are actually excluded", "[agenttxn]")
{
    // Each of these is MECHANICALLY safe (beginTxn + undoable=true + synchronous) and is
    // held out of v1 on purpose — see the header's reviewed-exclusions note. If one is
    // ever admitted, that must be a deliberate edit here too, not a silent widening.
    for (auto* c : { "remove_bus", "create_group_track", "ungroup_track",
                     "delete_time_range", "paste_clip", "relink_clip",
                     "freeze_layer", "bypass_layer", "bounce_layer_to_clip",
                     "set_master_volume", "add_rave_insert", "keep_take",
                     "create_annotation", "insert_tempo_change" })
        REQUIRE_FALSE (mosh::txnsafe::isSafe (c));
}
