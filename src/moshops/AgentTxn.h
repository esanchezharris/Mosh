#pragma once

#include <juce_data_structures/juce_data_structures.h>
#include <juce_cryptography/juce_cryptography.h>
#include <vector>

// FS-B2a — the PURE half of the agent batch-transaction contract
// (docs/first-stranger-program/lanes/fs-b2.md "Required native contract").
//
// Everything here is engine-free (juce_core/_data_structures/_cryptography only) so
// MoshTests can unit-test it with no Tracktion engine and no real session on disk. That
// split is deliberate: JUCE ignores $HOME, so a harness run always hits the REAL
// ~/Library/Mosh — the restart / needs_recovery path is therefore proven HERE, over
// synthesized ledger lines, not by crashing a run against the owner's own data.
//
// The engine-coupled half (the executeImpl guard, undo-head ownership, commit, exact
// rollback) lives in MoshOps and is proven by the --selftest TXN-* sections.
namespace mosh::agenttxn
{

// ── status vocabulary (fs-b2.md: open | failed | committed | rolled_back | needs_recovery) ──
inline const juce::String& statusOpen()          { static const juce::String s ("open");           return s; }
inline const juce::String& statusFailed()        { static const juce::String s ("failed");         return s; }
inline const juce::String& statusCommitted()     { static const juce::String s ("committed");      return s; }
inline const juce::String& statusRolledBack()    { static const juce::String s ("rolled_back");    return s; }
inline const juce::String& statusNeedsRecovery() { static const juce::String s ("needs_recovery"); return s; }

/** A status a *later* process must treat as unfinished business. */
inline bool isTerminalStatus (const juce::String& status)
{
    return status == statusCommitted() || status == statusRolledBack();
}

// ── per-entry state (fs-b2.md: pending | applied | failed) ──
inline const juce::String& entryPending() { static const juce::String s ("pending"); return s; }
inline const juce::String& entryApplied() { static const juce::String s ("applied"); return s; }
inline const juce::String& entryFailed()  { static const juce::String s ("failed");  return s; }

// ── stable failure codes. These are the contract's "stable failure code suitable for
//    user-facing refusal copy" — the UI maps them to text, so renaming one is a
//    breaking change. ──
inline const juce::String& codeNone()               { static const juce::String s;                                return s; }
inline const juce::String& codeManifestRejected()   { static const juce::String s ("manifest_rejected");           return s; }
inline const juce::String& codeIdentityConflict()   { static const juce::String s ("transaction_identity_conflict"); return s; }
inline const juce::String& codeAlreadyOpen()        { static const juce::String s ("transaction_already_open");    return s; }
inline const juce::String& codeInProgress()         { static const juce::String s ("transaction_in_progress");     return s; }
inline const juce::String& codeUnknownTxn()         { static const juce::String s ("unknown_transaction");         return s; }
inline const juce::String& codeManifestMismatch()   { static const juce::String s ("manifest_mismatch");           return s; }
inline const juce::String& codeEnvelopeConflict()   { static const juce::String s ("request_envelope_conflict");   return s; }
inline const juce::String& codeCommandFailed()      { static const juce::String s ("command_failed");              return s; }
inline const juce::String& codeIncomplete()         { static const juce::String s ("transaction_incomplete");      return s; }
inline const juce::String& codeUndoHeadMismatch()   { static const juce::String s ("undo_head_mismatch");          return s; }
inline const juce::String& codeFingerprintMismatch(){ static const juce::String s ("fingerprint_mismatch");        return s; }
inline const juce::String& codeUnresolvedRestart()  { static const juce::String s ("unresolved_after_restart");    return s; }
inline const juce::String& codeLedgerUnreadable()   { static const juce::String s ("ledger_unreadable");           return s; }

// ─────────────────────────────────────────────────────────────────────────────
// Canonical snapshot fingerprint
// ─────────────────────────────────────────────────────────────────────────────
//
// fs-b2.md requires rollback to verify "a deterministic rollback fingerprint against
// the captured pre-transaction state … excluding declared volatile telemetry". This is
// that declaration, and it is the whole load-bearing list: everything NOT named here is
// IN the fingerprint, so an under-restored track/clip/plugin/section can never hide.
//
// Paths are dot-paths into ops.snapshot(). Array indices are NOT part of a path — an
// array's elements all sit at their array's own path — so "tracks.input" excludes that
// field on every track, and "tracks" would (wrongly) exclude the entire arrangement.
// Nothing that describes the SONG may appear below.
inline const juce::StringArray& volatilePaths()
{
    static const juce::StringArray paths {
        // Playhead / play state, re-emitted at 30 Hz. Not song content.
        "transport",
        // Hardware-controller telemetry (fire-and-forget; see mark_take).
        "controller",
        // Live audio-device selection — machine state, not the song.
        "audio",
        // markDirty() is one-way: a rollback restores CONTENT but the edit is still
        // legitimately unsaved, so `dirty` must not be part of the identity.
        "session.dirty",
        // Device / machine / latency readouts.
        "session.sampleRate",
        "session.audioEnabled",
        "session.bitDepth",
        "session.bufferSize",
        "session.outputLatencyMs",
        "session.availableCores",
        "session.audioThreads",
        "session.audioThreadsAuto",
        "session.roundTripLatencySamples",
        "session.roundTripLatencyMs",
        "session.totalLatencySamples",
        "session.totalLatencyMs",
        "session.latencyContextReady",
        "session.audioDeviceName",
        "session.audioDeviceError",
        // Crash-recovery advisories (FS-T2's surface) and install-local facts.
        "session.recoveryAvailable",
        "session.recoverableCount",
        "session.recentProjects",
        "session.singVoiceEnrolled",
        "session.raveAvailable",
        "session.loadError",
        // Where the project lives is not what the project IS (and it is a home path).
        "session.editFile",
        "session.projectExtension",
    };
    return paths;
}

inline bool isVolatilePath (const juce::String& path)
{
    return volatilePaths().contains (path);
}

/** Deterministic serialization of a juce::var: object keys sorted, doubles fixed-width.
    `excludeVolatile` applies volatilePaths() by dot-path; pass false for a plain digest
    (manifests, envelopes) where nothing is volatile. */
inline juce::String canonicalize (const juce::var& value,
                                  bool excludeVolatile,
                                  const juce::String& path = {})
{
    if (value.isVoid() || value.isUndefined())   return "null";
    if (value.isBool())                          return ((bool) value) ? "true" : "false";
    if (value.isInt() || value.isInt64())        return juce::String ((juce::int64) value);
    if (value.isDouble())                        return juce::String ((double) value, 9);
    if (value.isString())                        return juce::JSON::toString (value, true);

    if (value.isArray())
    {
        // NB: bind the array to a named local — `if (auto* a = f().getArray())` lets the
        // juce::var temporary die at the end of the if-condition (a real use-after-free
        // this codebase has already paid for).
        const auto arrayVar = value;
        juce::StringArray parts;
        if (auto* a = arrayVar.getArray())
            for (const auto& e : *a)
                parts.add (canonicalize (e, excludeVolatile, path));
        return "[" + parts.joinIntoString (",") + "]";
    }

    if (auto* obj = value.getDynamicObject())
    {
        juce::StringArray keys;
        for (const auto& p : obj->getProperties())
            keys.add (p.name.toString());
        keys.sort (false);   // case-sensitive: deterministic and locale-free

        juce::StringArray parts;
        for (const auto& key : keys)
        {
            const auto childPath = path.isEmpty() ? key : path + "." + key;
            if (excludeVolatile && isVolatilePath (childPath))
                continue;
            parts.add (juce::JSON::toString (juce::var (key), true) + ":"
                       + canonicalize (obj->getProperty (juce::Identifier (key)),
                                       excludeVolatile, childPath));
        }
        return "{" + parts.joinIntoString (",") + "}";
    }

    return "null";
}

/** The semantic identity of a session: MD5 over the canonical snapshot minus the
    declared volatile paths. Equal fingerprints ⇒ the song is in the same state. */
inline juce::String fingerprint (const juce::var& snapshot)
{
    return juce::MD5 (canonicalize (snapshot, true).toUTF8()).toHexString();
}

/** MD5 over a canonicalized var with NO exclusions — used for manifest and
    command-envelope identity, where every field is significant. */
inline juce::String digestOf (const juce::var& value)
{
    return juce::MD5 (canonicalize (value, false).toUTF8()).toHexString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

struct ManifestEntry
{
    int          index = -1;
    juce::String requestId;
    juce::String command;
};

/** Parse and STRUCTURALLY validate batch_begin's `commands` array. Rejects a
    non-array, an empty manifest, a non-object entry, a missing/blank requestId or
    command, a duplicate requestId, and an index that is not its own position — all
    before any registry lookup, and therefore long before any mutation. */
inline bool parseManifest (const juce::var& commands,
                           std::vector<ManifestEntry>& out,
                           juce::String& error)
{
    out.clear();
    if (! commands.isArray())
    {
        error = "'commands' must be an array";
        return false;
    }

    const auto commandsVar = commands;   // named local: see canonicalize()
    auto* arr = commandsVar.getArray();
    if (arr == nullptr || arr->isEmpty())
    {
        error = "'commands' manifest is empty";
        return false;
    }

    juce::StringArray seenRequestIds;
    for (int i = 0; i < arr->size(); ++i)
    {
        const auto& entryVar = arr->getReference (i);
        if (entryVar.getDynamicObject() == nullptr)
        {
            error = "manifest entry " + juce::String (i) + " is not an object";
            return false;
        }

        ManifestEntry e;
        e.index     = (int) entryVar.getProperty ("index", juce::var (-1));
        e.requestId = entryVar.getProperty ("requestId", juce::var()).toString().trim();
        e.command   = entryVar.getProperty ("command", juce::var()).toString().trim();

        if (e.requestId.isEmpty())
        {
            error = "manifest entry " + juce::String (i) + " has no 'requestId'";
            return false;
        }
        if (e.command.isEmpty())
        {
            error = "manifest entry " + juce::String (i) + " has no 'command'";
            return false;
        }
        if (e.index != i)
        {
            error = "manifest entry " + juce::String (i) + " declares index "
                  + juce::String (e.index) + " (entries must be in order from 0)";
            return false;
        }
        if (seenRequestIds.contains (e.requestId))
        {
            error = "manifest reuses requestId " + e.requestId;
            return false;
        }
        seenRequestIds.add (e.requestId);
        out.push_back (e);
    }
    return true;
}

/** The identity of a manifest: skill name + every (index, requestId, command). Two
    batch_begin calls are "semantically identical" iff these match, which is what makes
    a retried begin idempotent and a mutated begin a hard error. */
inline juce::String manifestDigest (const juce::String& name,
                                    const std::vector<ManifestEntry>& entries)
{
    juce::StringArray parts;
    parts.add ("name=" + name);
    for (const auto& e : entries)
        parts.add (juce::String (e.index) + ":" + e.requestId + ":" + e.command);
    return juce::MD5 (parts.joinIntoString ("\n").toUTF8()).toHexString();
}

// ─────────────────────────────────────────────────────────────────────────────
// The in-memory transaction record
// ─────────────────────────────────────────────────────────────────────────────

struct Entry
{
    juce::String requestId;
    juce::String command;
    juce::String state = entryPending();
    juce::String envelopeDigest;   // set when the call is admitted; identity for replay
    juce::var    result;           // the recorded result envelope (never the args)
};

/** One agent transaction. MoshOps keeps exactly one — the MOST RECENT, whatever its
    status — so a lost `batch_end`/`batch_rollback` response and a post-commit command
    retry can both still be answered by id instead of inferred from a rejected promise. */
struct Record
{
    juce::String id, name, label, status, failureCode, manifestDigest, preFingerprint;
    juce::int64  revisionAtBegin = 0;
    int          nextIndex = 0;         // the only manifest index that may run next
    std::vector<Entry> entries;

    bool isOpen() const { return status == statusOpen() || status == statusFailed(); }

    int appliedCount() const
    {
        int n = 0;
        for (const auto& e : entries) if (e.state == entryApplied()) ++n;
        return n;
    }

    bool anyFailed() const
    {
        for (const auto& e : entries) if (e.state == entryFailed()) return true;
        return false;
    }

    bool allResolved() const { return nextIndex >= (int) entries.size(); }

    Entry* findByRequestId (const juce::String& requestId)
    {
        for (auto& e : entries) if (e.requestId == requestId) return &e;
        return nullptr;
    }

    int indexOfRequestId (const juce::String& requestId) const
    {
        for (int i = 0; i < (int) entries.size(); ++i)
            if (entries[(size_t) i].requestId == requestId) return i;
        return -1;
    }
};

/** The undo-transaction label for an id. Rollback proves ownership of the UndoManager
    head by comparing getUndoDescription() to exactly this string, so the prefix must
    stay stable and must not collide with a human-authored transaction name. */
inline juce::String labelFor (const juce::String& transactionId)
{
    return "agent-txn:" + transactionId;
}

/** What a rollback is allowed to do, given the UndoManager's head. */
enum class RollbackPlan
{
    UndoOurs,           // we own a non-empty head: undo exactly it
    NothingToUndo,      // our transaction performed no undoable action
    RefuseForeignHead   // someone else owns the head: refuse, and undo NOTHING
};

/** The whole rollback decision, as a pure function of the head — extracted so it can be
    tested exhaustively, because the RefuseForeignHead branch is (by design) unreachable
    through the public command seam: while a transaction is open MoshOps refuses every
    untagged mutation, so nothing can take the head from underneath it.

    NothingToUndo is NOT a synonym for UndoOurs, and conflating them is the G14
    empty-transaction bug: JUCE's beginNewTransaction is lazy, so a transaction that
    performed nothing has no ActionSet of its own, and undo() would reach back and destroy
    the PREVIOUS edit (juce_UndoManager.cpp:256 getCurrentSet()). */
inline RollbackPlan planRollback (int headActionCount,
                                  const juce::String& headName,
                                  const juce::String& ourLabel)
{
    if (headActionCount <= 0)     return RollbackPlan::NothingToUndo;
    if (headName != ourLabel)     return RollbackPlan::RefuseForeignHead;
    return RollbackPlan::UndoOurs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable ledger
// ─────────────────────────────────────────────────────────────────────────────
//
// A dedicated, VERSIONED JSONL beside mosh-log.jsonl, for the same reason FS-T2 gave
// for recovery-journal.jsonl and deliberately did not "fix": mosh-log.jsonl has no
// per-record schema version and no id-keyed structure, so it cannot be read back to
// answer "is a transaction unresolved?". Boundary/result records still ALSO go through
// logLine, so the existing seam keeps its complete picture.
//
// Per FS-T3/SPEC §1.6 this is new state and carries its own version rather than riding
// an unversioned field. It is NOT in the project ValueTree, so kMoshFormatVersion is
// not bumped (Migrations.h's rule: only a forward-incompatible Mosh-owned node needs a
// bump).
inline constexpr int kLedgerVersion = 1;

inline juce::String ledgerFileName() { return "agent-transactions.jsonl"; }

/** One ledger record. `command` is a command NAME only; args never appear here — the
    contract forbids it and args carry file paths, lyric text and track names. */
inline juce::var makeLedgerRecord (const juce::String& transactionId,
                                   const juce::String& name,
                                   const juce::String& status,
                                   const juce::String& failureCode,
                                   juce::int64 revision,
                                   const juce::String& preFingerprint,
                                   const juce::String& currentFingerprint,
                                   int appliedCount,
                                   int manifestCount)
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("v", kLedgerVersion);
    o->setProperty ("transactionId", transactionId);
    o->setProperty ("name", name);
    o->setProperty ("status", status);
    if (failureCode.isNotEmpty()) o->setProperty ("failureCode", failureCode);
    o->setProperty ("revision", revision);
    o->setProperty ("preFingerprint", preFingerprint);
    o->setProperty ("fingerprint", currentFingerprint);
    o->setProperty ("applied", appliedCount);
    o->setProperty ("manifestCount", manifestCount);
    return juce::var (o);
}

/** Every transaction id whose LAST record is non-terminal, in first-seen order.
    Unparseable and unversioned lines are skipped rather than fatal: a torn final line
    (the shape a crash actually leaves) must not make the whole ledger unreadable, and a
    torn line for an id whose `begin` was already recorded still leaves that id
    unresolved — which is the safe answer. */
inline juce::StringArray unresolvedIdsIn (const juce::StringArray& lines)
{
    juce::StringArray order;
    juce::HashMap<juce::String, juce::String> lastStatus;

    for (const auto& raw : lines)
    {
        const auto line = raw.trim();
        if (line.isEmpty()) continue;

        const auto record = juce::JSON::parse (line);
        if (record.getDynamicObject() == nullptr) continue;
        if ((int) record.getProperty ("v", juce::var (0)) != kLedgerVersion) continue;

        const auto id = record.getProperty ("transactionId", juce::var()).toString();
        const auto status = record.getProperty ("status", juce::var()).toString();
        if (id.isEmpty() || status.isEmpty()) continue;

        if (! lastStatus.contains (id)) order.add (id);
        lastStatus.set (id, status);
    }

    juce::StringArray unresolved;
    for (const auto& id : order)
        if (! isTerminalStatus (lastStatus[id]))
            unresolved.add (id);
    return unresolved;
}

} // namespace mosh::agenttxn
