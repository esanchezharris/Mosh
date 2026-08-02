#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <limits.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#if defined(MOSH_REPAIR_FIXTURE_CALLER)
namespace
{
void terminate (int)
{
    _exit (0);
}

pid_t spawnCommand (char** argv, int first, int last)
{
    const auto child = fork();
    if (child != 0) return child;
    std::vector<std::string> storage;
    storage.reserve (static_cast<size_t> (last - first));
    const auto callerPid = std::to_string (getppid());
    for (int index = first; index < last; ++index)
        storage.push_back (std::string (argv[index]) == "__CALLER_PID__"
            ? callerPid : argv[index]);
    std::vector<char*> arguments;
    for (auto& item : storage) arguments.push_back (item.data());
    arguments.push_back (nullptr);
    execv (arguments.front(), arguments.data());
    _exit (4);
}
}

int main (int argc, char** argv)
{
    if (argc < 2) return 2;
    signal (SIGTERM, terminate);
    if (std::string (argv[1]) == "__RACE_HANDOFFS__")
    {
        int separator = 0;
        for (int index = 2; index < argc; ++index)
            if (std::string (argv[index]) == "__SECOND_HANDOFF__")
                separator = index;
        if (separator == 0) return 8;
        const auto first = spawnCommand (argv, 2, separator);
        const auto second = spawnCommand (argv, separator + 1, argc);
        if (first < 0 || second < 0) return 3;
        int successful = 0;
        for (const auto child : { first, second })
        {
            int status = 0;
            if (waitpid (child, &status, 0) == child && WIFEXITED (status)
                && WEXITSTATUS (status) == 0)
                ++successful;
        }
        if (successful != 1) return 9;
    }
    else
    {
        const auto child = spawnCommand (argv, 1, argc);
        if (child < 0) return 3;
        int status = 0;
        if (waitpid (child, &status, 0) != child || ! WIFEXITED (status)
            || WEXITSTATUS (status) != 0)
            return 5;
    }
    while (true) pause();
}
#elif defined(MOSH_REPAIR_FIXTURE_TARGET)
#ifndef MOSH_REPAIR_FIXTURE_MARKER
#error MOSH_REPAIR_FIXTURE_MARKER is required
#endif
#ifndef MOSH_REPAIR_FIXTURE_SHA
#error MOSH_REPAIR_FIXTURE_SHA is required
#endif
#ifndef MOSH_REPAIR_FIXTURE_ID
#error MOSH_REPAIR_FIXTURE_ID is required
#endif

int main (int argc, char** argv)
{
    const std::string embeddedSha = MOSH_REPAIR_FIXTURE_SHA;
    const std::string repairId = MOSH_REPAIR_FIXTURE_ID;
    bool receivedSha = false;
    bool receivedCheckpoint = false;
    bool receivedRepairId = false;
    bool receivedPlaytestId = false;
    bool receivedRolledBackRepairId = false;
    bool receivedRolledBackRepairBuild = false;
    for (int index = 1; index + 1 < argc; ++index)
    {
        if (std::string (argv[index]) == "--mosh-repair-source-sha"
            && argv[index + 1] == embeddedSha)
            receivedSha = true;
        if (std::string (argv[index]) == "--mosh-owner-checkpoint")
            receivedCheckpoint = true;
        if (std::string (argv[index]) == "--mosh-repair-id"
            && argv[index + 1] == repairId)
            receivedRepairId = true;
        if (std::string (argv[index]) == "--mosh-owner-playtest-id"
            && std::string (argv[index + 1]) == "22222222-2222-4222-8222-222222222222")
            receivedPlaytestId = true;
        if (std::string (argv[index]) == "--mosh-rolled-back-repair-id"
            && argv[index + 1] == repairId)
            receivedRolledBackRepairId = true;
        if (std::string (argv[index]) == "--mosh-rolled-back-repair-build"
            && std::string (argv[index + 1]).ends_with ("Mosh.app"))
            receivedRolledBackRepairBuild = true;
    }
   #if defined(MOSH_REPAIR_FIXTURE_PRIOR_TARGET)
    if (! receivedCheckpoint || ! receivedRolledBackRepairId
        || ! receivedRolledBackRepairBuild || ! receivedPlaytestId)
        return 6;
    if (std::getenv ("MOSH_ACTIVE_REPAIR_SOURCE_SHA") != nullptr
        || std::getenv ("MOSH_ACTIVE_REPAIR_ID") != nullptr)
        return 9;
   #else
    if (! receivedSha || ! receivedCheckpoint || ! receivedRepairId || ! receivedPlaytestId)
        return 6;
   #endif
    for (int descriptor = 3; descriptor < getdtablesize(); ++descriptor)
    {
        char path[PATH_MAX] {};
        if (fcntl (descriptor, F_GETPATH, path) == 0
            && std::string (path).find ("mosh-repair-handoff-") != std::string::npos)
            return 8;
    }
    std::ofstream marker (MOSH_REPAIR_FIXTURE_MARKER, std::ios::app);
    marker << "launched " << getpid() << "\n";
    return marker.good() ? 0 : 7;
}
#else
#error Select MOSH_REPAIR_FIXTURE_CALLER or MOSH_REPAIR_FIXTURE_TARGET
#endif
