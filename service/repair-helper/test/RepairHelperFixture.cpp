#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
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
}

int main (int argc, char** argv)
{
    if (argc < 2) return 2;
    signal (SIGTERM, terminate);
    const auto child = fork();
    if (child < 0) return 3;
    if (child == 0)
    {
        std::vector<std::string> storage;
        storage.reserve (static_cast<size_t> (argc - 1));
        const auto callerPid = std::to_string (getppid());
        for (int index = 1; index < argc; ++index)
            storage.push_back (std::string (argv[index]) == "__CALLER_PID__"
                ? callerPid : argv[index]);
        std::vector<char*> arguments;
        for (auto& item : storage) arguments.push_back (item.data());
        arguments.push_back (nullptr);
        execv (arguments.front(), arguments.data());
        _exit (4);
    }
    int status = 0;
    if (waitpid (child, &status, 0) != child || ! WIFEXITED (status)
        || WEXITSTATUS (status) != 0)
        return 5;
    while (true) pause();
}
#elif defined(MOSH_REPAIR_FIXTURE_TARGET)
#ifndef MOSH_REPAIR_FIXTURE_MARKER
#error MOSH_REPAIR_FIXTURE_MARKER is required
#endif
#ifndef MOSH_REPAIR_FIXTURE_SHA
#error MOSH_REPAIR_FIXTURE_SHA is required
#endif

int main (int argc, char** argv)
{
    const std::string embeddedSha = MOSH_REPAIR_FIXTURE_SHA;
    bool receivedSha = false;
    for (int index = 1; index + 1 < argc; ++index)
        if (std::string (argv[index]) == "--mosh-repair-source-sha"
            && argv[index + 1] == embeddedSha)
            receivedSha = true;
    if (! receivedSha) return 6;
    std::ofstream marker (MOSH_REPAIR_FIXTURE_MARKER, std::ios::trunc);
    marker << "launched " << getpid() << "\n";
    return marker.good() ? 0 : 7;
}
#else
#error Select MOSH_REPAIR_FIXTURE_CALLER or MOSH_REPAIR_FIXTURE_TARGET
#endif
