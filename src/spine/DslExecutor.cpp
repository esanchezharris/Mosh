#include "DslExecutor.h"

namespace mosh
{
    void DslExecutor::registerCommand (juce::String name, Handler handler, bool transactional)
    {
        handlers[std::move (name)] = Entry { std::move (handler), transactional };
    }

    juce::StringArray DslExecutor::commandNames() const
    {
        juce::StringArray names;
        for (const auto& [name, entry] : handlers)
            names.add (name);
        return names;
    }

    void DslExecutor::addListener (MoshEventListener* l)
    {
        if (l != nullptr && std::find (listeners.begin(), listeners.end(), l) == listeners.end())
            listeners.push_back (l);
    }

    void DslExecutor::removeListener (MoshEventListener* l)
    {
        listeners.erase (std::remove (listeners.begin(), listeners.end(), l), listeners.end());
    }

    void DslExecutor::emit (const MoshEvent& e)
    {
        // Copy the listener list so a listener may unsubscribe during dispatch.
        auto snapshot = listeners;
        for (auto* l : snapshot)
            if (l != nullptr)
                l->onMoshEvent (e);
    }

    juce::var DslExecutor::getSnapshot()
    {
        if (snapshotSource != nullptr)
            return snapshotSource->getSnapshot();

        // Empty-but-valid snapshot (matches the schema so a cold UI renders).
        auto* o = new juce::DynamicObject();
        o->setProperty ("tracks", juce::Array<juce::var>());
        auto* transport = new juce::DynamicObject();
        transport->setProperty ("position", 0.0);
        transport->setProperty ("playing", false);
        transport->setProperty ("loop", juce::var());
        o->setProperty ("transport", juce::var (transport));
        auto* tempo = new juce::DynamicObject();
        tempo->setProperty ("bpm", 120.0);
        tempo->setProperty ("sig", "4/4");
        o->setProperty ("tempo", juce::var (tempo));
        return juce::var (o);
    }

    MoshResult DslExecutor::execute (const MoshCommand& cmd)
    {
        MoshResult result;

        auto it = handlers.find (cmd.name);
        if (it == handlers.end())
        {
            result = MoshResult::failure (error::unknownCommand, "Unknown command: " + cmd.name);
            if (log != nullptr)
                log->append (cmd.name, cmd.args, result);
            return result;
        }

        const auto& entry = it->second;
        Context ctx (*this, undo);

        if (entry.transactional)
        {
            // One transaction per command → one user-meaningful undo step (02 §6).
            undo.beginNewTransaction (cmd.name);

            try
            {
                result = entry.handler (cmd, ctx);
            }
            catch (const std::exception& e)
            {
                result = MoshResult::failure (error::internalError, juce::String (e.what()));
            }
            catch (...)
            {
                result = MoshResult::failure (error::internalError, "Unknown exception in handler");
            }

            // On failure, abandon any partial mutation so the tree is never left
            // half-changed (02 §6 — no partial mutations).
            if (! result.ok)
                undo.undoCurrentTransactionOnly();
        }
        else
        {
            // Non-transactional built-ins (undo/redo) operate the stack directly.
            try
            {
                result = entry.handler (cmd, ctx);
            }
            catch (const std::exception& e)
            {
                result = MoshResult::failure (error::internalError, juce::String (e.what()));
            }
            catch (...)
            {
                result = MoshResult::failure (error::internalError, "Unknown exception in handler");
            }
        }

        if (log != nullptr)
            log->append (cmd.name, cmd.args, result);

        return result;
    }

    void DslExecutor::registerBuiltins()
    {
        // undo / redo — operate Tracktion's UndoManager (the one undo system). They
        // emit a resync hint; the UI refetches getSnapshot() (02 §8 — simplest
        // correct path; optimize to inverse-deltas only if resync feels heavy).
        registerCommand ("undo", [] (const MoshCommand&, Context& ctx) -> MoshResult
        {
            const bool did = ctx.undoManager().undo();
            ctx.emit (events::snapshotInvalidated());
            return MoshResult::success (did ? "Undid last command" : "Nothing to undo");
        }, /*transactional*/ false);

        registerCommand ("redo", [] (const MoshCommand&, Context& ctx) -> MoshResult
        {
            const bool did = ctx.undoManager().redo();
            ctx.emit (events::snapshotInvalidated());
            return MoshResult::success (did ? "Redid command" : "Nothing to redo");
        }, /*transactional*/ false);
    }
}
