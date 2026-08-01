#pragma once

#if ! JUCE_WINDOWS

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

    inline bool removeEntry (int parentFd, const std::string& name);

    inline bool removeDirectoryContents (int directoryFd)
    {
        const auto duplicate = ::dup (directoryFd);
        if (duplicate < 0)
            return false;

        auto* stream = ::fdopendir (duplicate);
        if (stream == nullptr)
        {
            ::close (duplicate);
            return false;
        }

        std::vector<std::string> names;
        while (auto* entry = ::readdir (stream))
        {
            const std::string name (entry->d_name);
            if (name == "." || name == "..")
                continue;
            names.push_back (name);
        }
        ::closedir (stream);

        bool ok = true;
        for (const auto& name : names)
            if (! removeEntry (directoryFd, name))
                ok = false;
        return ok;
    }

    inline bool removeEntry (int parentFd, const std::string& name)
    {
        const auto before = identityAt (parentFd, name);
        if (! before)
            return errno == ENOENT;

        if (! S_ISDIR (before->mode))
        {
            const auto current = identityAt (parentFd, name);
            return current && sameIdentity (*before, *current)
                && ::unlinkat (parentFd, name.c_str(), 0) == 0;
        }

        auto directory = openChildDirectory (parentFd, name);
        const auto opened = directory ? identityForFd (directory.get()) : std::nullopt;
        if (! opened || ! sameIdentity (*before, *opened)
            || ! removeDirectoryContents (directory.get()))
            return false;

        const auto current = identityAt (parentFd, name);
        return current && sameIdentity (*opened, *current)
            && ::unlinkat (parentFd, name.c_str(), AT_REMOVEDIR) == 0;
    }

    inline std::optional<std::string> nameForIdentity (
        int parentFd, const FileIdentity& wanted)
    {
        const auto duplicate = ::dup (parentFd);
        if (duplicate < 0)
            return std::nullopt;
        auto* stream = ::fdopendir (duplicate);
        if (stream == nullptr)
        {
            ::close (duplicate);
            return std::nullopt;
        }

        std::optional<std::string> result;
        while (auto* entry = ::readdir (stream))
        {
            const std::string name (entry->d_name);
            if (name == "." || name == "..")
                continue;
            const auto identity = identityAt (parentFd, name);
            if (identity && sameIdentity (*identity, wanted))
            {
                result = name;
                break;
            }
        }
        ::closedir (stream);
        return result;
    }
}

#endif
