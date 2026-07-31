#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <spawn.h>
#include <signal.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
extern char** environ;

namespace
{
constexpr auto kMoshIdentifier = "studio.mosh.app";
constexpr auto kHelperIdentifier = "MoshRepairHelper";
constexpr int kReadyDescriptor = 3;

class CfObject
{
public:
    explicit CfObject (CFTypeRef value = nullptr) : value_ (value) {}
    ~CfObject() { if (value_ != nullptr) CFRelease (value_); }
    CfObject (const CfObject&) = delete;
    CfObject& operator= (const CfObject&) = delete;
    CfObject (CfObject&& other) noexcept : value_ (other.value_) { other.value_ = nullptr; }
    CFTypeRef get() const { return value_; }

private:
    CFTypeRef value_;
};

struct Identity
{
    std::string identifier;
    std::string team;
};

[[noreturn]] void fail (const std::string& code, const std::string& message)
{
    std::cerr << "{\"ok\":false,\"code\":\"" << code << "\",\"message\":\""
              << message << "\"}\n";
    std::exit (1);
}

std::string stringValue (CFTypeRef value)
{
    if (value == nullptr || CFGetTypeID (value) != CFStringGetTypeID())
        return {};
    const auto text = static_cast<CFStringRef> (value);
    const auto length = CFStringGetLength (text);
    const auto maximum = CFStringGetMaximumSizeForEncoding (length, kCFStringEncodingUTF8) + 1;
    std::vector<char> buffer (static_cast<size_t> (maximum));
    if (! CFStringGetCString (text, buffer.data(), maximum, kCFStringEncodingUTF8))
        return {};
    return buffer.data();
}

Identity signingIdentity (SecStaticCodeRef code)
{
    CFDictionaryRef raw = nullptr;
    if (SecCodeCopySigningInformation (code, kSecCSSigningInformation, &raw) != errSecSuccess)
        throw std::runtime_error ("signing_info_unavailable");
    CfObject information (raw);
    const auto dictionary = static_cast<CFDictionaryRef> (information.get());
    return {
        stringValue (CFDictionaryGetValue (dictionary, kSecCodeInfoIdentifier)),
        stringValue (CFDictionaryGetValue (dictionary, kSecCodeInfoTeamIdentifier)),
    };
}

Identity selfIdentity()
{
    SecCodeRef raw = nullptr;
    if (SecCodeCopySelf (kSecCSDefaultFlags, &raw) != errSecSuccess)
        throw std::runtime_error ("helper_identity_unavailable");
    CfObject code (raw);
    const auto identity = signingIdentity (
        reinterpret_cast<SecStaticCodeRef> (const_cast<void*> (code.get())));
    if (identity.team.empty())
        throw std::runtime_error ("helper_team_missing");
    return identity;
}

Identity guestIdentity (pid_t pid)
{
    const auto rawPid = static_cast<int> (pid);
    CfObject number (CFNumberCreate (kCFAllocatorDefault, kCFNumberIntType, &rawPid));
    const void* keys[] = { kSecGuestAttributePid };
    const void* values[] = { number.get() };
    CfObject attributes (CFDictionaryCreate (
        kCFAllocatorDefault, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
    SecCodeRef raw = nullptr;
    if (SecCodeCopyGuestWithAttributes (
            nullptr,
            static_cast<CFDictionaryRef> (attributes.get()),
            kSecCSDefaultFlags,
            &raw) != errSecSuccess)
        throw std::runtime_error ("caller_identity_unavailable");
    CfObject code (raw);
    const auto typed = reinterpret_cast<SecCodeRef> (const_cast<void*> (code.get()));
    if (SecCodeCheckValidity (typed, kSecCSStrictValidate, nullptr) != errSecSuccess)
        throw std::runtime_error ("caller_signature_invalid");
    return signingIdentity (reinterpret_cast<SecStaticCodeRef> (typed));
}

Identity pathIdentity (const fs::path& path)
{
    const auto bytes = path.string();
    CfObject url (CFURLCreateFromFileSystemRepresentation (
        kCFAllocatorDefault,
        reinterpret_cast<const UInt8*> (bytes.data()),
        static_cast<CFIndex> (bytes.size()),
        true));
    SecStaticCodeRef raw = nullptr;
    if (SecStaticCodeCreateWithPath (
            static_cast<CFURLRef> (url.get()),
            kSecCSDefaultFlags,
            &raw) != errSecSuccess)
        throw std::runtime_error ("target_identity_unavailable");
    CfObject code (raw);
    const auto typed = static_cast<SecStaticCodeRef> (code.get());
    if (SecStaticCodeCheckValidity (
            typed,
            kSecCSStrictValidate | kSecCSCheckAllArchitectures,
            nullptr) != errSecSuccess)
        throw std::runtime_error ("target_signature_invalid");
    return signingIdentity (typed);
}

pid_t parentPid (pid_t pid)
{
    proc_bsdinfo information {};
    const auto bytes = proc_pidinfo (
        pid, PROC_PIDTBSDINFO, 0, &information, sizeof (information));
    return bytes == sizeof (information) ? static_cast<pid_t> (information.pbi_ppid) : -1;
}

fs::path processAppPath (pid_t pid)
{
    std::array<char, PROC_PIDPATHINFO_MAXSIZE> buffer {};
    if (proc_pidpath (pid, buffer.data(), static_cast<uint32_t> (buffer.size())) <= 0)
        return {};
    auto executable = fs::weakly_canonical (fs::path (buffer.data()));
    if (executable.parent_path().filename() != "MacOS")
        return {};
    const auto contents = executable.parent_path().parent_path();
    if (contents.filename() != "Contents")
        return {};
    const auto app = contents.parent_path();
    return app.extension() == ".app" ? app : fs::path {};
}

pid_t parsePid (const char* value)
{
    try
    {
        const auto parsed = std::stoll (value);
        if (parsed <= 1 || parsed > INT32_MAX)
            throw std::runtime_error ("range");
        return static_cast<pid_t> (parsed);
    }
    catch (...)
    {
        fail ("caller_pid_invalid", "Caller PID is invalid");
    }
}

void rejectSymlinks (const fs::path& candidate)
{
    fs::path current;
    for (const auto& component : candidate)
    {
        current /= component;
        struct stat status {};
        if (lstat (current.c_str(), &status) != 0)
            throw std::runtime_error ("path_missing");
        if (S_ISLNK (status.st_mode))
            throw std::runtime_error ("path_symlink");
    }
}

fs::path canonicalPath (const char* raw, bool directory)
{
    fs::path input (raw);
    if (! input.is_absolute())
        throw std::runtime_error ("path_not_absolute");
    rejectSymlinks (input);
    const auto canonical = fs::canonical (input);
    if (canonical != input.lexically_normal())
        throw std::runtime_error ("path_not_canonical");
    if (directory ? ! fs::is_directory (canonical) : ! fs::is_regular_file (canonical))
        throw std::runtime_error ("path_wrong_type");
    return canonical;
}

bool isDescendant (const fs::path& root, const fs::path& candidate)
{
    const auto relative = candidate.lexically_relative (root);
    return ! relative.empty()
        && ! relative.is_absolute()
        && *relative.begin() != "..";
}

bool containsBytes (const fs::path& file, const std::string& needle)
{
    std::ifstream input (file, std::ios::binary);
    if (! input) return false;
    const std::string bytes {
        std::istreambuf_iterator<char> (input),
        std::istreambuf_iterator<char>() };
    return bytes.find (needle) != std::string::npos;
}

void validateCaller (pid_t callerPid, const Identity& helper)
{
    const auto directParent = getppid();
    if (callerPid != directParent && callerPid != parentPid (directParent))
        throw std::runtime_error ("caller_chain_invalid");
    const auto caller = guestIdentity (callerPid);
    if (caller.identifier != kMoshIdentifier || caller.team != helper.team)
        throw std::runtime_error ("caller_identity_mismatch");
}

void validateCallerIdentity (pid_t callerPid, const Identity& helper)
{
    const auto caller = guestIdentity (callerPid);
    if (caller.identifier != kMoshIdentifier || caller.team != helper.team)
        throw std::runtime_error ("caller_identity_mismatch");
}

void validateWorkerParent (pid_t parentHelperPid, const Identity& helper)
{
    if (getppid() != parentHelperPid)
        throw std::runtime_error ("worker_parent_chain_invalid");
    const auto parent = guestIdentity (parentHelperPid);
    if (parent.identifier != kHelperIdentifier || parent.team != helper.team)
        throw std::runtime_error ("worker_parent_identity_mismatch");
}

void validateTarget (const fs::path& app, const Identity& helper)
{
    const auto target = pathIdentity (app);
    if (target.identifier != kMoshIdentifier || target.team != helper.team)
        throw std::runtime_error ("target_identity_mismatch");
}

struct RepairTarget
{
    fs::path app;
    fs::path worktree;
    std::string sourceSha;
};

RepairTarget repairTarget (
    const char* appValue,
    const char* worktreeValue,
    const char* shaValue,
    const Identity& helper)
{
    const auto worktree = canonicalPath (worktreeValue, true);
    const auto app = canonicalPath (appValue, true);
    const std::string sourceSha (shaValue);
    if (sourceSha.size() != 40
        || sourceSha.find_first_not_of ("0123456789abcdef") != std::string::npos)
        throw std::runtime_error ("source_sha_invalid");
    if (app.extension() != ".app" || ! isDescendant (worktree, app))
        throw std::runtime_error ("repair_target_outside_worktree");
    const auto executable = canonicalPath (
        (app / "Contents" / "MacOS" / "Mosh").c_str(), false);
    if (! isDescendant (worktree, executable) || ! containsBytes (executable, sourceSha))
        throw std::runtime_error ("repair_source_mismatch");
    validateTarget (app, helper);
    return { app, worktree, sourceSha };
}

struct PriorTarget
{
    fs::path checkpoint;
    fs::path app;
};

PriorTarget priorTarget (
    const char* checkpointValue,
    const char* appValue,
    const Identity& helper)
{
    const auto checkpoint = canonicalPath (checkpointValue, false);
    const auto app = canonicalPath (appValue, true);
    if (app.extension() != ".app")
        throw std::runtime_error ("prior_app_invalid");
    validateTarget (app, helper);
    return { checkpoint, app };
}

bool isRunning (pid_t pid)
{
    proc_bsdinfo information {};
    const auto bytes = proc_pidinfo (
        pid, PROC_PIDTBSDINFO, 0, &information, sizeof (information));
    if (bytes == sizeof (information) && information.pbi_status == SZOMB)
        return false;
    return kill (pid, 0) == 0 || errno == EPERM;
}

void writeTestStatus (const std::string& value)
{
    if (const auto* statusPath = std::getenv ("MOSH_REPAIR_HELPER_TEST_STATUS");
        statusPath != nullptr)
    {
        std::ofstream status (statusPath, std::ios::trunc);
        status << value << "\n";
    }
}

[[noreturn]] void workerExit (int code)
{
    writeTestStatus (std::to_string (code));
    _exit (code);
}

pid_t spawnWorker (const std::vector<std::string>& arguments)
{
    std::array<char, PROC_PIDPATHINFO_MAXSIZE> selfBuffer {};
    if (proc_pidpath (getpid(), selfBuffer.data(), static_cast<uint32_t> (selfBuffer.size())) <= 0)
        throw std::runtime_error ("helper_path_unavailable");
    std::vector<std::string> storage { selfBuffer.data() };
    storage.insert (storage.end(), arguments.begin(), arguments.end());
    storage.push_back (std::to_string (getpid()));
    std::vector<char*> argv;
    argv.reserve (storage.size() + 1);
    for (auto& item : storage) argv.push_back (item.data());
    argv.push_back (nullptr);

    int readyPipe[2] {};
    if (pipe (readyPipe) != 0)
        throw std::runtime_error ("handoff_ready_pipe_failed");
    posix_spawn_file_actions_t actions;
    if (posix_spawn_file_actions_init (&actions) != 0)
    {
        close (readyPipe[0]);
        close (readyPipe[1]);
        throw std::runtime_error ("handoff_spawn_actions_failed");
    }
    const auto destroyActions = [&actions] { posix_spawn_file_actions_destroy (&actions); };
    if (posix_spawn_file_actions_addopen (
            &actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) != 0
        || posix_spawn_file_actions_addopen (
            &actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) != 0
        || posix_spawn_file_actions_addopen (
            &actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) != 0
        || posix_spawn_file_actions_addclose (&actions, readyPipe[0]) != 0
        || posix_spawn_file_actions_adddup2 (
            &actions, readyPipe[1], kReadyDescriptor) != 0
        || (readyPipe[1] != kReadyDescriptor
            && posix_spawn_file_actions_addclose (&actions, readyPipe[1]) != 0))
    {
        destroyActions();
        close (readyPipe[0]);
        close (readyPipe[1]);
        throw std::runtime_error ("handoff_spawn_redirect_failed");
    }
    pid_t workerPid = -1;
    const auto result = posix_spawn (
        &workerPid, storage.front().c_str(), &actions, nullptr, argv.data(), environ);
    destroyActions();
    close (readyPipe[1]);
    if (result != 0 || workerPid <= 1)
    {
        close (readyPipe[0]);
        throw std::runtime_error ("handoff_spawn_failed");
    }
    pollfd ready { readyPipe[0], POLLIN | POLLHUP, 0 };
    const auto pollResult = poll (&ready, 1, 5000);
    char byte = 0;
    const auto readResult = pollResult > 0 ? read (readyPipe[0], &byte, 1) : -1;
    close (readyPipe[0]);
    if (readResult != 1 || byte != 'R')
        throw std::runtime_error ("handoff_worker_not_ready");
    return workerPid;
}

template <typename CallerValidator, typename TargetValidator>
[[noreturn]] void runWorker (
    pid_t parentHelperPid,
    pid_t callerPid,
    const fs::path& targetApp,
    const std::vector<std::string>& arguments,
    CallerValidator validateCallerNow,
    TargetValidator validateTargetNow)
{
    writeTestStatus ("started");
    try
    {
        validateWorkerParent (parentHelperPid, selfIdentity());
        validateCallerNow();
        validateTargetNow();
    }
    catch (...) { workerExit (70); }
    if (write (kReadyDescriptor, "R", 1) != 1)
        workerExit (76);
    close (kReadyDescriptor);
    std::this_thread::sleep_for (std::chrono::milliseconds (750));
    writeTestStatus ("validated");
    if (kill (callerPid, SIGTERM) != 0 && errno != ESRCH)
        workerExit (71);
    writeTestStatus ("signalled");
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds (30);
    while (isRunning (callerPid) && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for (std::chrono::milliseconds (100));
    if (isRunning (callerPid))
        workerExit (72);
    try { validateTargetNow(); } catch (...) { workerExit (73); }
    writeTestStatus ("exec");

    const auto executable = targetApp / "Contents" / "MacOS" / "Mosh";
    std::vector<std::string> storage { executable.string() };
    storage.insert (storage.end(), arguments.begin(), arguments.end());
    std::vector<char*> argv;
    argv.reserve (storage.size() + 1);
    for (auto& item : storage) argv.push_back (item.data());
    argv.push_back (nullptr);
    execv (executable.c_str(), argv.data());
    workerExit (74);
}

void acceptHandoff (
    pid_t callerPid,
    const fs::path& targetApp,
    const std::vector<std::string>& workerArguments)
{
    if (const auto callerApp = processAppPath (callerPid); ! callerApp.empty()
        && fs::weakly_canonical (callerApp) == targetApp)
    {
        std::cout << "{\"ok\":true,\"alreadyRunning\":true}\n";
        return;
    }
    const auto workerPid = spawnWorker (workerArguments);
    std::cout << "{\"ok\":true,\"workerPid\":" << workerPid
              << ",\"callerPid\":" << callerPid << "}\n";
}
}

int main (int argc, char** argv)
{
    if (argc < 2)
        fail ("usage", "A repair helper action is required");
    try
    {
        const auto helper = selfIdentity();
        const std::string action (argv[1]);
        if (action == "__worker-repair")
        {
            if (argc != 8) workerExit (75);
            const auto callerPid = parsePid (argv[6]);
            const auto parentHelperPid = parsePid (argv[7]);
            runWorker (
                parentHelperPid,
                callerPid,
                canonicalPath (argv[2], true),
                { "--mosh-repair-source-sha", argv[4],
                  "--mosh-owner-checkpoint", argv[5] },
                [=] { validateCallerIdentity (callerPid, helper); },
                [=] {
                    repairTarget (argv[2], argv[3], argv[4], helper);
                    canonicalPath (argv[5], false);
                });
        }
        if (action == "__worker-prior")
        {
            if (argc != 6) workerExit (75);
            const auto callerPid = parsePid (argv[4]);
            const auto parentHelperPid = parsePid (argv[5]);
            runWorker (
                parentHelperPid,
                callerPid,
                canonicalPath (argv[3], true),
                { "--mosh-owner-checkpoint", argv[2] },
                [=] { validateCallerIdentity (callerPid, helper); },
                [=] { priorTarget (argv[2], argv[3], helper); });
        }
        if (action == "probe")
        {
            if (argc != 3) fail ("usage", "probe requires callerPid");
            validateCaller (parsePid (argv[2]), helper);
            std::cout << "{\"ok\":true,\"callerVerified\":true}\n";
            return 0;
        }
        if (action == "handoff-repair")
        {
            if (argc != 7)
                fail ("usage", "handoff-repair requires app, worktree, sourceSha, checkpoint, callerPid");
            const auto callerPid = parsePid (argv[6]);
            validateCaller (callerPid, helper);
            const auto target = repairTarget (argv[2], argv[3], argv[4], helper);
            const auto checkpoint = canonicalPath (argv[5], false);
            acceptHandoff (
                callerPid,
                target.app,
                { "__worker-repair", target.app.string(), target.worktree.string(),
                  target.sourceSha, checkpoint.string(), std::to_string (callerPid) });
            return 0;
        }
        if (action == "handoff-prior")
        {
            if (argc != 5)
                fail ("usage", "handoff-prior requires checkpoint, app, callerPid");
            const auto callerPid = parsePid (argv[4]);
            validateCaller (callerPid, helper);
            const auto target = priorTarget (argv[2], argv[3], helper);
            acceptHandoff (
                callerPid,
                target.app,
                { "__worker-prior", target.checkpoint.string(), target.app.string(),
                  std::to_string (callerPid) });
            return 0;
        }
        fail ("action_refused", "Unknown repair helper action");
    }
    catch (const std::exception& error)
    {
        fail (error.what(), "Repair helper validation failed");
    }
}
