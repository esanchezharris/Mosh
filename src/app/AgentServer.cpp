#include "AgentServer.h"
#include "../engine/MoshEngine.h"
#include "../moshops/MoshOps.h"
#include <juce_core/juce_core.h>
#include <iostream>
#include <string>

namespace mosh
{
using namespace juce;

namespace
{
    var makeErr (const String& message)
    {
        auto* o = new DynamicObject();
        o->setProperty ("ok", false);
        o->setProperty ("error", message);
        return var (o);
    }

    void emit (const var& v)
    {
        // One response per line, marker-prefixed so the harness can filter engine /
        // library chatter that lands on stdout.
        std::cout << "@@MOSH@@" << JSON::toString (v, true).toStdString() << std::endl;
        std::cout.flush();
    }
}

int runAgentServer (MoshEngine& engine, MoshOps& ops)
{
    ignoreUnused (engine);
    std::cerr << "agent-server: ready (JSON-lines on stdin; responses prefixed @@MOSH@@)" << std::endl;

    std::string raw;
    while (std::getline (std::cin, raw))
    {
        String line = String (raw).trim();
        if (line.isEmpty()) continue;

        var parsed = JSON::parse (line);
        if (! parsed.isObject())
        {
            emit (makeErr ("agent-server: line is not a JSON object"));
            continue;
        }

        const auto op = parsed.getProperty ("op", var()).toString();
        if (op == "quit") break;

        if (op == "snapshot")
        {
            emit (ops.snapshot());
            continue;
        }

        // Default: a {command, args} envelope through the one mutation path.
        emit (ops.execute (parsed));
    }

    std::cerr << "agent-server: stdin closed, exiting" << std::endl;
    return 0;
}
}
