// SparkleUpdater_stub.cpp — the non-Apple implementation of the SparkleUpdater
// surface. Same pattern as src/voice/NativeSpeech_stub.cpp: Sparkle is a macOS
// framework, so Windows and Linux get a TU that satisfies the header and reports
// itself unavailable. Callers (Main.cpp, MenuController) stay platform-free.
//
// Windows auto-update is not built — see docs/WINDOWS_PARITY.md. Whatever fills that
// role there (WinSparkle, MSIX, Squirrel) will replace this file, not the header.

#include "SparkleUpdater.h"

namespace mosh
{

struct SparkleUpdater::Impl {};

SparkleUpdater::SparkleUpdater() : impl (std::make_unique<Impl>()) {}
SparkleUpdater::~SparkleUpdater() = default;

bool SparkleUpdater::isAvailable() const  { return false; }
juce::String SparkleUpdater::feedUrl() const { return {}; }
void SparkleUpdater::checkForUpdates()    {}

} // namespace mosh
