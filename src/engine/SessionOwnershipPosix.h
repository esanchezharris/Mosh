#pragma once

#if ! JUCE_WINDOWS

#include <cctype>
#include <cerrno>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <filesystem>
#include <optional>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace mosh::sessionpaths::detail
{
    class OwnedFd
    {
    public:
        OwnedFd() = default;
        explicit OwnedFd (int descriptor) : fd (descriptor) {}
        ~OwnedFd() { reset(); }

        OwnedFd (OwnedFd&& other) noexcept : fd (other.release()) {}
        OwnedFd& operator= (OwnedFd&& other) noexcept
        {
            if (this != &other)
            {
                reset();
                fd = other.release();
            }
            return *this;
        }

        OwnedFd (const OwnedFd&) = delete;
        OwnedFd& operator= (const OwnedFd&) = delete;

        explicit operator bool() const { return fd >= 0; }
        int get() const { return fd; }

    private:
        int release()
        {
            const auto result = fd;
            fd = -1;
            return result;
        }

        void reset()
        {
            if (fd >= 0)
                ::close (fd);
            fd = -1;
        }

        int fd = -1;
    };

    struct FileIdentity
    {
        dev_t device {};
        ino_t inode {};
        mode_t mode {};
    };

    inline std::optional<FileIdentity> identityForFd (int fd)
    {
        struct stat status {};
        if (::fstat (fd, &status) != 0)
            return std::nullopt;
        return FileIdentity { status.st_dev, status.st_ino, status.st_mode };
    }

    inline std::optional<FileIdentity> identityAt (int parentFd, const std::string& name)
    {
        struct stat status {};
        if (::fstatat (parentFd, name.c_str(), &status, AT_SYMLINK_NOFOLLOW) != 0)
            return std::nullopt;
        return FileIdentity { status.st_dev, status.st_ino, status.st_mode };
    }

    inline bool sameIdentity (const FileIdentity& a, const FileIdentity& b)
    {
        return a.device == b.device && a.inode == b.inode;
    }

    inline bool validComponent (const std::string& component)
    {
        return ! component.empty() && component != "." && component != ".."
            && component.find ('/') == std::string::npos;
    }

    inline OwnedFd openAbsoluteDirectory (const juce::File& directory, bool createMissing)
    {
        const std::filesystem::path path (
            directory.getFullPathName().toStdString());
        if (! path.is_absolute())
            return {};

        OwnedFd current (::open ("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
        if (! current)
            return {};

        for (const auto& part : path.lexically_normal().relative_path())
        {
            const auto component = part.string();
            if (! validComponent (component))
                return {};

            auto next = OwnedFd (::openat (current.get(), component.c_str(),
                                           O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
            if (! next && createMissing && errno == ENOENT)
            {
                if (::mkdirat (current.get(), component.c_str(), 0700) != 0 && errno != EEXIST)
                    return {};
                next = OwnedFd (::openat (current.get(), component.c_str(),
                                          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
            }
            if (! next)
                return {};
            current = std::move (next);
        }
        return current;
    }

    inline std::optional<std::vector<std::string>> relativeComponents (
        const juce::File& root, const juce::File& candidate)
    {
        const std::filesystem::path rootPath (
            root.getFullPathName().toStdString());
        const std::filesystem::path candidatePath (
            candidate.getFullPathName().toStdString());
        if (! rootPath.is_absolute() || ! candidatePath.is_absolute())
            return std::nullopt;

        const auto relative = candidatePath.lexically_normal().lexically_relative (
            rootPath.lexically_normal());
        if (relative.empty() || relative.is_absolute())
            return std::nullopt;

        std::vector<std::string> result;
        for (const auto& part : relative)
        {
            const auto component = part.string();
            if (component == ".")
                continue;
            if (! validComponent (component))
                return std::nullopt;
            result.push_back (component);
        }
        if (result.empty())
            return std::nullopt;
        return result;
    }

    struct OpenedParent
    {
        OwnedFd fd;
        std::string leaf;
    };

    inline std::optional<OpenedParent> openParent (
        const juce::File& root, const juce::File& candidate,
        bool createRoot, bool createParents)
    {
        auto components = relativeComponents (root, candidate);
        if (! components)
            return std::nullopt;

        auto current = openAbsoluteDirectory (root, createRoot);
        if (! current)
            return std::nullopt;

        for (size_t i = 0; i + 1 < components->size(); ++i)
        {
            const auto& component = (*components)[i];
            auto next = OwnedFd (::openat (current.get(), component.c_str(),
                                           O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
            if (! next && createParents && errno == ENOENT)
            {
                if (::mkdirat (current.get(), component.c_str(), 0700) != 0 && errno != EEXIST)
                    return std::nullopt;
                next = OwnedFd (::openat (current.get(), component.c_str(),
                                          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
            }
            if (! next)
                return std::nullopt;
            current = std::move (next);
        }

        return OpenedParent { std::move (current), components->back() };
    }

    inline OwnedFd openChildDirectory (int parentFd, const std::string& name)
    {
        return OwnedFd (::openat (parentFd, name.c_str(),
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    }

    inline bool markerMatches (int directoryFd, const char* markerName,
                               const char* expectedContents)
    {
        OwnedFd marker (::openat (directoryFd, markerName,
                                  O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
        if (! marker)
            return false;

        const auto markerIdentity = identityForFd (marker.get());
        if (! markerIdentity || ! S_ISREG (markerIdentity->mode))
            return false;

        const auto expectedSize = std::strlen (expectedContents);
        std::string actual (expectedSize + 1, '\0');
        const auto bytes = ::read (marker.get(), actual.data(), actual.size());
        return bytes == static_cast<ssize_t> (expectedSize)
            && std::memcmp (actual.data(), expectedContents, expectedSize) == 0;
    }

    inline bool writeMarker (int directoryFd, const char* markerName,
                             const char* contents)
    {
        OwnedFd marker (::openat (directoryFd, markerName,
                                  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                                  0600));
        if (! marker)
            return false;

        const auto size = std::strlen (contents);
        size_t written = 0;
        while (written < size)
        {
            const auto bytes = ::write (marker.get(), contents + written, size - written);
            if (bytes <= 0)
            {
                ::unlinkat (directoryFd, markerName, 0);
                return false;
            }
            written += static_cast<size_t> (bytes);
        }
        if (::fsync (marker.get()) != 0)
        {
            ::unlinkat (directoryFd, markerName, 0);
            return false;
        }
        return true;
    }

    // --- Quarantine reclaim --------------------------------------------------------
    // Everything below walks a tree through descriptors only. An entry is inspected with
    // fstatat(AT_SYMLINK_NOFOLLOW); a directory is entered with O_NOFOLLOW and only when
    // the opened descriptor is the inode that fstatat saw, on the tree's own device.

    inline constexpr int kMaxReclaimDepth = 64;

    inline std::string lowercase (std::string text)
    {
        for (auto& c : text)
            c = static_cast<char> (std::tolower (static_cast<unsigned char> (c)));
        return text;
    }

    /** Model, adapter and checkpoint files (or bundle directories) a reclaim must keep. */
    inline bool isModelFileName (const std::string& name)
    {
        static constexpr const char* suffixes[] = {
            ".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".onnx", ".npz", ".h5",
            ".tflite", ".mlmodel", ".mlpackage", ".mlmodelc" };
        const auto lower = lowercase (name);
        for (const auto* suffix : suffixes)
        {
            const auto length = std::strlen (suffix);
            if (lower.size() > length
                && lower.compare (lower.size() - length, length, suffix) == 0)
                return true;
        }
        return false;
    }

    /** True when a word of the name (split on - _ . and space) says adapter, checkpoint,
        LoRA or evaluation. Such a directory is evidence once it has any content. */
    inline bool isEvidenceDirectoryName (const std::string& name)
    {
        static constexpr const char* words[] = {
            "adapter", "adapters", "checkpoint", "checkpoints", "lora", "loras",
            "eval", "evals", "evaluation", "evaluations" };
        const auto lower = lowercase (name);
        size_t start = 0;
        while (start <= lower.size())
        {
            auto end = lower.find_first_of ("-_. ", start);
            if (end == std::string::npos)
                end = lower.size();
            const auto word = lower.substr (start, end - start);
            for (const auto* evidence : words)
                if (word == evidence)
                    return true;
            start = end + 1;
        }
        return false;
    }

    inline bool readEntryNames (int directoryFd, std::vector<std::string>& names)
    {
        const auto copy = ::dup (directoryFd);   // fdopendir owns and closes its descriptor
        if (copy < 0)
            return false;
        auto* directory = ::fdopendir (copy);
        if (directory == nullptr)
        {
            ::close (copy);
            return false;
        }
        ::rewinddir (directory);
        errno = 0;
        while (const auto* entry = ::readdir (directory))
        {
            const std::string name (entry->d_name);
            if (name != "." && name != "..")
                names.push_back (name);
        }
        const auto readAll = errno == 0;
        ::closedir (directory);
        return readAll;
    }

    inline OwnedFd openVerifiedChildDirectory (int parentFd, const std::string& name,
                                               dev_t device)
    {
        const auto seen = identityAt (parentFd, name);
        if (! seen || ! S_ISDIR (seen->mode) || seen->device != device)
            return {};
        auto child = openChildDirectory (parentFd, name);
        const auto opened = child ? identityForFd (child.get()) : std::nullopt;
        if (! opened || ! sameIdentity (*seen, *opened))
            return {};
        return child;
    }

    /** True if the tree holds evidence, or if it could not be fully inspected. */
    inline bool containsRetainedEvidence (int directoryFd, dev_t device, int depth)
    {
        std::vector<std::string> names;
        if (depth > kMaxReclaimDepth || ! readEntryNames (directoryFd, names))
            return true;

        for (const auto& name : names)
        {
            const auto identity = identityAt (directoryFd, name);
            if (! identity)
                return true;
            if (isModelFileName (name))
                return true;
            if (! S_ISDIR (identity->mode))
                continue;

            auto child = openVerifiedChildDirectory (directoryFd, name, device);
            if (! child)
                return true;
            if (isEvidenceDirectoryName (name))
            {
                std::vector<std::string> children;
                if (! readEntryNames (child.get(), children) || ! children.empty())
                    return true;
                continue;
            }
            if (containsRetainedEvidence (child.get(), device, depth + 1))
                return true;
        }
        return false;
    }

    /** Unlinks everything below the directory; returns false if anything remains. */
    inline bool removeTreeContents (int directoryFd, dev_t device, int depth)
    {
        std::vector<std::string> names;
        if (depth > kMaxReclaimDepth || ! readEntryNames (directoryFd, names))
            return false;

        auto removedAll = true;
        for (const auto& name : names)
        {
            const auto identity = identityAt (directoryFd, name);
            if (! identity)
            {
                removedAll = removedAll && errno == ENOENT;
                continue;
            }

            if (S_ISDIR (identity->mode))
            {
                auto child = openVerifiedChildDirectory (directoryFd, name, device);
                if (! child || ! removeTreeContents (child.get(), device, depth + 1)
                    || ::unlinkat (directoryFd, name.c_str(), AT_REMOVEDIR) != 0)
                    removedAll = false;
            }
            else if (::unlinkat (directoryFd, name.c_str(), 0) != 0 && errno != ENOENT)
            {
                removedAll = false;
            }
        }
        return removedAll;
    }
}

#endif
