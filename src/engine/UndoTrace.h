#pragma once

#include <tracktion_engine/tracktion_engine.h>

#include <cstdio>
#include <deque>

#if JUCE_MAC || JUCE_LINUX
 #include <cxxabi.h>
 #include <execinfo.h>
#endif
#if JUCE_MAC
 #include <mach-o/dyld.h>
#endif

// Debug-only undo-stack tracer (MOSH_UNDO_TRACE).
//
// The command log's `txn` stamp mirrors the Edit's UndoManager, so a stamp that moves on
// a line logged undoable:false means SOMETHING wrote through the UndoManager outside a
// MoshOps command. That is how the 2026-09-23 walkthrough lost Keep to ⌘Z: a hidden
// transaction landed between play and the first audition switch, and undo reverted it
// instead of Keep. The log shows THAT it happened, never WHO did it.
//
// With MOSH_UNDO_TRACE set, this answers the second question:
//   * every change to the Edit's undo stack is logged: depth, redo depth, the head's
//     description, its action count, and the MoshOps command in flight (if any);
//   * every Edit-tree write made while NO command is running is kept (raw stack, cheap),
//     and when the undo stack grows with no command in flight those writes are dumped
//     with symbolized stacks — the file:line of the writer.
//
// MOSH_UNDO_TRACE=1 writes to stderr; an absolute path appends JSON lines to that file.
// Unset (the default) it is inert: one cached bool test per command, nothing attached.
namespace mosh::undotrace
{
namespace te = tracktion::engine;

inline const juce::String& setting()
{
    static const juce::String s =
        juce::SystemStats::getEnvironmentVariable ("MOSH_UNDO_TRACE", {}).trim();
    return s;
}

inline bool enabled()
{
    static const bool on = setting().isNotEmpty() && setting() != "0";
    return on;
}

struct CommandState
{
    juce::StringArray stack;     // outermost → innermost MoshOps command in flight
    juce::int64 entered = 0;     // monotonic: bumps on every command entry
};

inline CommandState& commandState()
{
    static CommandState s;
    return s;
}

/** Marks a MoshOps command as in flight for the tracer (message thread only). */
class ScopedCommand
{
public:
    explicit ScopedCommand (const juce::String& name)
        : active (enabled())
    {
        if (! active) return;
        auto& s = commandState();
        s.stack.add (name.isEmpty() ? juce::String ("?") : name);
        ++s.entered;
    }
    ~ScopedCommand()
    {
        if (active)
            commandState().stack.strings.removeLast();
    }
    ScopedCommand (const ScopedCommand&) = delete;
    ScopedCommand& operator= (const ScopedCommand&) = delete;

private:
    const bool active;
};

inline void writeLine (const juce::var& obj)
{
    const auto line = juce::JSON::toString (obj, true) + "\n";
    const auto& where = setting();
    if (juce::File::isAbsolutePath (where))
    {
        juce::FileOutputStream out { juce::File (where) };
        if (out.openedOk())
        {
            out.writeText (line, false, false, nullptr);
            out.flush();
            return;
        }
    }
    std::fputs (("[undo-trace] " + line).toRawUTF8(), stderr);
    std::fflush (stderr);
}

/** One symbolized frame, demangled where possible. Keeps the raw address so an offline
    `atos -o Mosh -l <loadAddress> <addr>` can recover file:line. */
inline juce::String describeFrame (const char* raw)
{
    juce::String line (raw);
   #if JUCE_MAC
    // "3   Mosh   0x0000000100d23e68 _ZN4juce11UndoManager7performEPNS_14UndoableActionE + 60"
    auto tokens = juce::StringArray::fromTokens (line, " ", {});
    tokens.removeEmptyStrings();
    if (tokens.size() >= 4)
    {
        int status = 0;
        char* demangled = abi::__cxa_demangle (tokens[3].toRawUTF8(), nullptr, nullptr, &status);
        if (status == 0 && demangled != nullptr)
        {
            tokens.set (3, demangled);
            line = tokens.joinIntoString (" ");
        }
        std::free (demangled);
    }
   #endif
    return line;
}

class Tracer : private juce::ValueTree::Listener,
               private juce::Timer
{
public:
    Tracer() = default;
    ~Tracer() override { detach(); }

    void attach (te::Edit& edit)
    {
        detach();
        editRef = &edit;
        root = edit.state;
        root.addListener (this);
        sample (true, "attach");
        startTimer (20);
    }

    void detach()
    {
        stopTimer();
        if (root.isValid())
            root.removeListener (this);
        root = {};
        editRef = nullptr;
        pending.clear();
    }

private:
    struct Write
    {
        juce::int64 ts = 0;
        juce::String op, tree, detail;
        void* frames[64] {};
        int numFrames = 0;
    };

    juce::WeakReference<te::Selectable> editRef;   // liveness: the Edit is replaced on new/open project
    juce::ValueTree root;

    te::Edit* liveEdit() const { return static_cast<te::Edit*> (editRef.get()); }
    std::deque<Write> pending;   // Edit writes made with no command in flight, since the last sample
    int lastUndo = -1, lastRedo = -1, lastActions = -1;
    juce::String lastHead;
    juce::int64 lastEntered = 0;

    static juce::String treeName (const juce::ValueTree& t)
    {
        auto s = t.getType().toString();
        if (t.hasProperty (te::IDs::id))
            s << "#" << t[te::IDs::id].toString();
        return s;
    }

    void note (const juce::String& op, const juce::ValueTree& tree, const juce::String& detail)
    {
        auto* edit = liveEdit();
        if (edit == nullptr || edit->getUndoManager().isPerformingUndoRedo())
            return;
        if (! commandState().stack.isEmpty())
            return;   // inside a command: the stack-change line names the command

        Write w;
        w.ts = juce::Time::currentTimeMillis();
        w.op = op;
        w.tree = treeName (tree);
        w.detail = detail.substring (0, 160);
       #if JUCE_MAC || JUCE_LINUX
        w.numFrames = ::backtrace (w.frames, (int) juce::numElementsInArray (w.frames));
       #endif
        pending.push_back (w);
        if (pending.size() > 128)
            pending.pop_front();
    }

    void valueTreePropertyChanged (juce::ValueTree& t, const juce::Identifier& p) override
    {
        note ("property", t, p.toString() + "=" + t[p].toString());
    }
    void valueTreeChildAdded (juce::ValueTree& parent, juce::ValueTree& child) override
    {
        note ("childAdded", parent, treeName (child));
    }
    void valueTreeChildRemoved (juce::ValueTree& parent, juce::ValueTree& child, int) override
    {
        note ("childRemoved", parent, treeName (child));
    }
    void valueTreeChildOrderChanged (juce::ValueTree& parent, int from, int to) override
    {
        note ("childOrder", parent, juce::String (from) + "->" + juce::String (to));
    }

    void timerCallback() override { sample (false, {}); }

    void sample (bool force, const juce::String& why)
    {
        auto* edit = liveEdit();
        if (edit == nullptr)
            return;
        auto& um = edit->getUndoManager();
        const int u = um.getUndoDescriptions().size();
        const int r = um.getRedoDescriptions().size();
        const int actions = um.getNumActionsInCurrentTransaction();
        const auto head = um.getUndoDescription();
        auto& cmd = commandState();
        const bool changed = u != lastUndo || r != lastRedo || actions != lastActions || head != lastHead;

        if (force || changed)
        {
            // No command entered since the last sample and none in flight now ⇒ the
            // growth was made by something other than a MoshOps command.
            const bool grew = u > lastUndo || (u == lastUndo && actions > lastActions);
            const bool outsideCommand = cmd.entered == lastEntered && cmd.stack.isEmpty();

            auto* o = new juce::DynamicObject();
            o->setProperty ("ts", juce::Time::currentTimeMillis());
            o->setProperty ("kind", force ? why : juce::String ("undo_stack"));
            o->setProperty ("undo", u);
            o->setProperty ("redo", r);
            o->setProperty ("head", head);
            o->setProperty ("actionsInHead", actions);
            o->setProperty ("commandsSinceLast", (int) (cmd.entered - lastEntered));
            o->setProperty ("inFlight", cmd.stack.joinIntoString (">"));
           #if JUCE_MAC
            if (force)
                o->setProperty ("loadAddress", juce::String::toHexString (
                    (juce::pointer_sized_int) _dyld_get_image_header (0)));
           #endif
            if (! force && grew && ! pending.empty())
            {
                o->setProperty ("hidden", outsideCommand);
                juce::Array<juce::var> writes;
                for (auto& w : pending)
                    writes.add (describe (w));
                o->setProperty ("writesOutsideCommands", writes);
            }
            writeLine (juce::var (o));
        }

        lastUndo = u; lastRedo = r; lastActions = actions; lastHead = head;
        lastEntered = cmd.entered;
        pending.clear();
    }

    static juce::var describe (const Write& w)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("ts", w.ts);
        o->setProperty ("op", w.op);
        o->setProperty ("tree", w.tree);
        o->setProperty ("detail", w.detail);
        juce::Array<juce::var> frames;
       #if JUCE_MAC || JUCE_LINUX
        if (char** symbols = ::backtrace_symbols (const_cast<void* const*> (w.frames), w.numFrames))
        {
            for (int i = 0; i < w.numFrames; ++i)
                frames.add (describeFrame (symbols[i]));
            std::free (symbols);
        }
       #endif
        o->setProperty ("stack", frames);
        return juce::var (o);
    }
};

} // namespace mosh::undotrace
