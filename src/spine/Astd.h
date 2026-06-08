#pragma once
#include <juce_core/juce_core.h>
#include <algorithm>
#include <cmath>

// ──────────────────────────────────────────────────────────────────────────────
// ASTD — quality-aware slider reparameterization (04 §6, 05 §6). One shared impl,
// both tiers (real-time neural + generative).
//
// Every over-driveable neural param is a 0–100 UI control. By default the UI range
// maps onto a CLAMPED raw sub-range that stays below the point production quality
// collapses. "Lab mode" unlocks the full raw range behind a warning.
//
// "Defeatable by default": the clamp is the trusted, never-sounds-broken default;
// Lab mode is the deliberate escape hatch into the broken/alien range.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    struct AstdParam
    {
        juce::String paramId;          // model-facing param name (e.g. "gain", "cfg")
        double rawMin = 0.0;           // full model range
        double rawMax = 1.0;
        double safeMin = 0.0;          // clamped, production-safe sub-range
        double safeMax = 1.0;          //   (safeMin..safeMax ⊆ rawMin..rawMax)
        double skew = 1.0;             // >1 biases UI resolution toward the low end

        bool isValid() const
        {
            return rawMax > rawMin
                && safeMax >= safeMin
                && safeMin >= rawMin - 1e-9
                && safeMax <= rawMax + 1e-9
                && skew > 0.0;
        }

        // UI 0..100 → raw model value. labMode picks the full range; otherwise the
        // clamped safe range. skew applies a perceptual curve within the chosen range.
        double uiToRaw (double ui0to100, bool labMode) const
        {
            const double t = applySkew (juce::jlimit (0.0, 100.0, ui0to100) / 100.0);
            const double lo = labMode ? rawMin : safeMin;
            const double hi = labMode ? rawMax : safeMax;
            return lo + t * (hi - lo);
        }

        // raw model value → UI 0..100 (inverse of uiToRaw within the active range).
        double rawToUi (double raw, bool labMode) const
        {
            const double lo = labMode ? rawMin : safeMin;
            const double hi = labMode ? rawMax : safeMax;
            if (hi <= lo)
                return 0.0;
            const double t = juce::jlimit (0.0, 1.0, (raw - lo) / (hi - lo));
            return removeSkew (t) * 100.0;
        }

        // The raw value a UI request maps to *after* clamping. In non-Lab mode a raw
        // value above safeMax is pulled back to safeMax (the clamp guarantee).
        double clampRaw (double raw, bool labMode) const
        {
            return labMode ? juce::jlimit (rawMin, rawMax, raw)
                           : juce::jlimit (safeMin, safeMax, raw);
        }

    private:
        double applySkew  (double t) const { return skew == 1.0 ? t : std::pow (t, skew); }
        double removeSkew (double t) const { return skew == 1.0 ? t : std::pow (t, 1.0 / skew); }
    };

    // A registry of ASTD params (per model / per adapter). Backed by data so it can
    // be loaded from the colors/ASTD config (05) or hardcoded for Tier-A models.
    class AstdRegistry
    {
    public:
        void set (AstdParam p)            { params[p.paramId] = std::move (p); }
        bool has (const juce::String& id) const { return params.count (id) > 0; }

        const AstdParam* find (const juce::String& id) const
        {
            auto it = params.find (id);
            return it == params.end() ? nullptr : &it->second;
        }

        // Convenience: UI 0..100 → clamped raw, or fall through unmapped value as-is.
        double uiToRaw (const juce::String& id, double ui, bool labMode) const
        {
            if (auto* p = find (id))
                return p->uiToRaw (ui, labMode);
            return ui; // unmapped params pass through (caller decides meaning)
        }

        int size() const { return (int) params.size(); }

    private:
        std::map<juce::String, AstdParam> params;
    };
}
