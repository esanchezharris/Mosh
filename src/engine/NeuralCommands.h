#pragma once
#include "DslExecutor.h"
#include "MoshEngine.h"

// ──────────────────────────────────────────────────────────────────────────────
// Stage 4 — Tier-A neural insert command surface (04): add_neural_insert /
// set_neural_param (ASTD-clamped 0–100 → raw) / set_neural_lab_mode (unlock the raw
// range) / bypass_neural_insert. ASTD is ONE shared impl (the spine `Astd`), both
// tiers. The anira model inference + the PDC null test are the macOS half of the gate.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    void registerNeuralCommands (DslExecutor&, MoshEngine&);
}
