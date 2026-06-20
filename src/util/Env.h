#pragma once

// Portable process-environment mutation.
//
// POSIX setenv()/unsetenv() do not exist on MSVC; Windows uses _putenv_s().
// These are used only on CLI/selftest setup paths (e.g. forcing MOSH_ENABLE_SA3=0
// for a deep scan, or seeding brain-provider keys in the selftest), never on the
// audio thread. Reading env vars goes through juce::SystemStats::getEnvironmentVariable.

#include <juce_core/juce_core.h>
#include <cstdlib>

namespace mosh
{

/** Set (overwriting) an environment variable for THIS process. */
inline void setEnvVar (const char* name, const char* value)
{
   #if JUCE_WINDOWS
    _putenv_s (name, value);
   #else
    ::setenv (name, value, /*overwrite=*/1);
   #endif
}

/** Remove an environment variable from THIS process's environment. On Windows,
    _putenv_s(name, "") deletes the variable (per the CRT contract). */
inline void unsetEnvVar (const char* name)
{
   #if JUCE_WINDOWS
    _putenv_s (name, "");
   #else
    ::unsetenv (name);
   #endif
}

} // namespace mosh
