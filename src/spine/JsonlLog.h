#pragma once
#include <juce_core/juce_core.h>
#include "MoshResult.h"
#include <functional>

// ──────────────────────────────────────────────────────────────────────────────
// The JSONL semantic log (02 §5) — the taste flywheel. Every command appends one
// line:
//   {"ts","cmd","args","ok","changed_entities","data"}
// This is a semantic audit trail (NOT a CRDT op-log yet). Jobs: deterministic
// self-tests (replay), debugging, and acceptance signals (accept_render /
// reject_render are taste labels). Never log view-state churn here.
//
// Keeps lines in memory (for tests / replay) and optionally appends to a file.
// The clock is injectable so tests are deterministic.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class JsonlLog
    {
    public:
        using Clock = std::function<juce::String()>;   // → ISO-8601 timestamp

        explicit JsonlLog (Clock clockToUse = defaultClock()) : clock (std::move (clockToUse)) {}

        // Mirror appends to this file (created/opened for append). Optional.
        void setFile (juce::File f)
        {
            file = std::move (f);
            if (file != juce::File())
                file.getParentDirectory().createDirectory();
        }

        void append (const juce::String& cmd, const juce::var& args, const MoshResult& result)
        {
            auto* o = new juce::DynamicObject();
            o->setProperty ("ts", clock());
            o->setProperty ("cmd", cmd);
            o->setProperty ("args", args.isVoid() ? juce::var (new juce::DynamicObject()) : args);
            o->setProperty ("ok", result.ok);

            juce::Array<juce::var> changed;
            for (const auto& e : result.changedEntities)
                changed.add (e);
            o->setProperty ("changed_entities", changed);
            o->setProperty ("data", result.data.isVoid() ? juce::var (new juce::DynamicObject()) : result.data);
            if (! result.ok)
                o->setProperty ("error_code", result.errorCode);

            const auto line = juce::JSON::toString (juce::var (o), true); // one line
            inMemory.add (line);

            if (file != juce::File())
                file.appendText (line + "\n");
        }

        const juce::StringArray& lines() const { return inMemory; }
        int size() const { return inMemory.size(); }
        void clear() { inMemory.clear(); }

        static Clock defaultClock()
        {
            return [] { return juce::Time::getCurrentTime().toISO8601 (true); };
        }

    private:
        Clock clock;
        juce::StringArray inMemory;
        juce::File file;
    };
}
