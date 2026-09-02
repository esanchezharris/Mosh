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
