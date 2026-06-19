#pragma once

#include <juce_core/juce_core.h>
#include <map>

namespace mosh
{

/** The native, local mirror of the relay's lock table + the command guard that
    enforces it at the one mutation path (MoshOps::execute()).

    Engine-free (no Tracktion): it classifies a command by NAME and decides allow/
    deny against a RESOLVED lock key. MoshOps owns the engine-coupled half — turning
    a command's trackId/clipId arg into the affected track's logicalId (the key the
    relay locks on). When no multiplayer session is active the guard is a no-op, so
    single-player behaviour is unchanged. */
class LockManager
{
public:
    enum class Scope
    {
        Unguarded,      // reads / transport / undo / meters / io / the MP commands
        Track,          // mutates one track (key = that track's logicalId)
        Clip,           // mutates one clip  (key = the clip's track logicalId)
        SessionGlobal   // structural/global (key = SESSION_KEY) — also the fail-closed default
    };

    /** The lock key for session-structural/global operations. */
    static const juce::String& sessionKey();

    /** Classify a command by name. Unknown/unlisted commands fail CLOSED to
        SessionGlobal (require the session lock) — new commands are guarded until
        deliberately classified. Pure + static (Catch2-testable). */
    static Scope classify (const juce::String& command);

    // ── session lifecycle ───────────────────────────────────────────────────
    void activate (const juce::String& selfPeerId) { active_ = true; selfPeer_ = selfPeerId; }
    void deactivate() { active_ = false; selfPeer_.clear(); locks_.clear(); }
    bool isActive() const { return active_; }
    juce::String selfPeer() const { return selfPeer_; }

    /** Mirror the relay's lock table (called from the poll path). key -> ownerPeerId. */
    void setLocks (std::map<juce::String, juce::String> locks) { locks_ = std::move (locks); }
    juce::String ownerOf (const juce::String& key) const;   // "" when free

    struct Decision { bool allow = true; juce::String reason; };

    /** Decide allow/deny for a command of `scope` whose lock key resolved to
        `resolvedKey`. Allowed unless the key is held by the OTHER peer. An inactive
        session, an Unguarded scope, or a free/own key all allow. Pure. */
    Decision decide (Scope scope, const juce::String& resolvedKey) const;

private:
    bool active_ = false;
    juce::String selfPeer_;
    std::map<juce::String, juce::String> locks_;   // key -> owner peerId
};

} // namespace mosh
