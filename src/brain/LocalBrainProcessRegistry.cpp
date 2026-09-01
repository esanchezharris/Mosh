#include "LocalBrainProcessRegistry.h"

#if JUCE_MAC || JUCE_LINUX
 #include <cerrno>
 #include <csignal>
 #include <cstdlib>
 #include <sys/stat.h>
 #include <unistd.h>
#endif
#if JUCE_MAC
 #include <sys/sysctl.h>
#elif JUCE_LINUX
 #include <limits.h>
#endif

#include <vector>
#include <limits.h>

namespace mosh
{
using namespace juce;

namespace
{
struct ProcessRecord
{
    int pid = 0;
    String user;
    File pythonRuntime;
    File modelPath;
    String host;
    int port = 0;
};

struct ProcessArguments
{
    String executable;
    StringArray arguments;
};

String canonicalPath (const File& file)
{
   #if JUCE_MAC || JUCE_LINUX
    std::vector<char> resolved (PATH_MAX + 1, 0);
    if (::realpath (file.getFullPathName().toRawUTF8(), resolved.data()) != nullptr)
        return String::fromUTF8 (resolved.data());
   #endif
    return file.getFullPathName();
}

bool readPrivateRecord (const File& file, ProcessRecord& record)
{
   #if JUCE_MAC || JUCE_LINUX
    struct stat info {};
    struct stat directoryInfo {};
    if (::lstat (file.getFullPathName().toRawUTF8(), &info) != 0
        || ! S_ISREG (info.st_mode)
        || info.st_uid != ::getuid()
        || (info.st_mode & 077) != 0
        || ::stat (file.getParentDirectory().getFullPathName().toRawUTF8(), &directoryInfo) != 0
        || ! S_ISDIR (directoryInfo.st_mode)
        || directoryInfo.st_uid != ::getuid()
        || (directoryInfo.st_mode & 077) != 0)
        return false;
   #endif

    const auto root = JSON::parse (file.loadFileAsString());
    if (! root.isObject() || root.getProperty ("owner", var()).toString() != "Mosh")
        return false;
    record.pid = (int) root.getProperty ("pid", 0);
    record.user = root.getProperty ("user", var()).toString();
    record.pythonRuntime = File (root.getProperty ("pythonRuntime", var()).toString());
    record.modelPath = File (root.getProperty ("modelPath", var()).toString());
    record.host = root.getProperty ("host", var()).toString();
    record.port = (int) root.getProperty ("port", 0);
    return record.pid > 1
        && file.getFileNameWithoutExtension() == String (record.pid)
        && record.user == SystemStats::getLogonName()
        && File::isAbsolutePath (record.pythonRuntime.getFullPathName())
        && File::isAbsolutePath (record.modelPath.getFullPathName())
        && record.host == "127.0.0.1"
        && record.port >= 1024
        && record.port <= 65535;
}

bool matchesExpected (const ProcessRecord& record, const LocalBrainExpectedProcess& expected)
{
    return canonicalPath (record.pythonRuntime) == canonicalPath (expected.pythonRuntime)
        && canonicalPath (record.modelPath) == canonicalPath (expected.modelPath)
        && record.host == expected.host
        && record.port == expected.port;
}

bool processExists (int pid)
{
   #if JUCE_MAC || JUCE_LINUX
    return ::kill (pid, 0) == 0 || errno != ESRCH;
   #else
    ignoreUnused (pid);
    return false;
   #endif
}

ProcessArguments readProcessArguments (int pid)
{
    ProcessArguments result;
   #if JUCE_MAC
    int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
    size_t size = 0;
    if (::sysctl (mib, 3, nullptr, &size, nullptr, 0) != 0 || size <= sizeof (int))
        return result;
    std::vector<char> data (size, 0);
    if (::sysctl (mib, 3, data.data(), &size, nullptr, 0) != 0 || size <= sizeof (int))
        return result;
    const int argc = *reinterpret_cast<const int*> (data.data());
    const char* cursor = data.data() + sizeof (int);
    const char* end = data.data() + size;
    result.executable = String::fromUTF8 (cursor);
    while (cursor < end && *cursor != '\0') ++cursor;
    while (cursor < end && *cursor == '\0') ++cursor;
    for (int index = 0; index < argc && cursor < end; ++index)
    {
        result.arguments.add (String::fromUTF8 (cursor));
        while (cursor < end && *cursor != '\0') ++cursor;
        while (cursor < end && *cursor == '\0') ++cursor;
    }
   #elif JUCE_LINUX
    const auto proc = File ("/proc").getChildFile (String (pid));
    std::vector<char> executable (PATH_MAX + 1, 0);
    const auto length = ::readlink (proc.getChildFile ("exe").getFullPathName().toRawUTF8(),
                                    executable.data(), executable.size() - 1);
    if (length > 0) result.executable = String::fromUTF8 (executable.data(), (int) length);
    MemoryBlock command;
    if (proc.getChildFile ("cmdline").loadFileAsData (command))
    {
        const char* cursor = static_cast<const char*> (command.getData());
        const char* end = cursor + command.getSize();
        while (cursor < end)
        {
            result.arguments.add (String::fromUTF8 (cursor));
            while (cursor < end && *cursor != '\0') ++cursor;
            while (cursor < end && *cursor == '\0') ++cursor;
        }
    }
   #else
    ignoreUnused (pid);
   #endif
    return result;
}

bool liveCommandMatches (const ProcessRecord& record)
{
    const auto process = readProcessArguments (record.pid);
    const StringArray expected {
        record.pythonRuntime.getFullPathName(),
        "-m", "mlx_lm.server",
        "--model", record.modelPath.getFullPathName(),
        "--host", record.host,
        "--port", String (record.port)
    };
    return canonicalPath (File (process.executable)) == canonicalPath (record.pythonRuntime)
        && process.arguments == expected;
}

bool terminatePid (int pid, int graceMs)
{
   #if JUCE_MAC || JUCE_LINUX
    if (::kill (pid, SIGTERM) != 0 && errno != ESRCH) return false;
    const auto deadline = Time::getMillisecondCounter() + (uint32) jmax (0, graceMs);
    while ((int32) (deadline - Time::getMillisecondCounter()) > 0)
    {
        if (::kill (pid, 0) != 0 && errno == ESRCH) return true;
        Thread::sleep (20);
    }
    return ::kill (pid, SIGKILL) == 0 || errno == ESRCH;
   #else
    ignoreUnused (pid, graceMs);
    return false;
   #endif
}
}

File LocalBrainProcessRegistry::defaultDirectory()
{
    const auto overridePath = SystemStats::getEnvironmentVariable ("MOSH_LOCAL_BRAIN_RUNTIME_DIR", {}).trim();
    const auto runtime = overridePath.isNotEmpty()
        ? File (overridePath)
        : File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Mosh/runtime");
    return runtime.getChildFile ("local-brain-processes");
}

bool LocalBrainProcessRegistry::recordMatchesExpected (const File& recordFile,
                                                       const LocalBrainExpectedProcess& expected)
{
    ProcessRecord record;
    return readPrivateRecord (recordFile, record) && matchesExpected (record, expected);
}

bool LocalBrainProcessRegistry::terminateOwnedProcess (const File& recordFile,
                                                       const LocalBrainExpectedProcess& expected,
                                                       int graceMs)
{
    ProcessRecord record;
    if (! readPrivateRecord (recordFile, record) || ! matchesExpected (record, expected))
        return false;
    if (! processExists (record.pid))
        return recordFile.deleteFile();
    if (! liveCommandMatches (record) || ! terminatePid (record.pid, graceMs))
        return false;
    return recordFile.deleteFile();
}

LocalBrainReapResult LocalBrainProcessRegistry::reapOwnedProcesses (
    const File& recordDirectory,
    int graceMs)
{
    LocalBrainReapResult result;
    Array<File> files;
    recordDirectory.findChildFiles (files, File::findFiles, false, "*.json");
    for (const auto& file : files)
    {
        ProcessRecord record;
        if (! readPrivateRecord (file, record))
        {
            ++result.ignored;
            continue;
        }
        if (! processExists (record.pid))
        {
            if (file.deleteFile()) ++result.staleRemoved;
            else ++result.ignored;
            continue;
        }
        if (! liveCommandMatches (record) || ! terminatePid (record.pid, graceMs))
        {
            ++result.ignored;
            continue;
        }
        if (file.deleteFile()) ++result.terminated;
        else ++result.ignored;
    }
    return result;
}
}
