#pragma once
#include "DslExecutor.h"
#include "MoshEngine.h"

// ──────────────────────────────────────────────────────────────────────────────
// Stage 3 — plugin hosting via commands (04). load_plugin / remove_plugin /
// reorder_plugin / bypass_plugin over Tracktion's plugin model (built-ins now;
// hosted VST3/AU via ExternalPlugin once scanned). `set_plugin_param` and
// `open_plugin_editor` (the native pop-out) land with the ExternalPlugin editor
// `// VERIFY` — resolved/tested on macOS where editors + real VST3s run.
//
// The command surface is verifiable on Windows with Tracktion's BUILT-IN plugins
// (no external VST3 file needed); the snapshot surfaces each track's plugins
// ({id,type,name,bypassed}).
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    void registerPluginCommands (DslExecutor&, MoshEngine&);
}
