#pragma once
#include <optional>
#include <utility>
#include <algorithm>

// ──────────────────────────────────────────────────────────────────────────────
// ClipMath — pure clip-position geometry for move/trim/split (06 §4 "clip-position
// math"). The Tracktion-bound command handlers (move_clip/trim_clip/split_clip)
// apply these results to the Edit tree; the geometry itself is pure and unit-tested.
//
// A clip occupies [start, end) on the timeline and reads its source starting at
// `offset` seconds in (mirrors Tracktion's ClipPosition: a TimeRange + an offset).
// Times are seconds. No JUCE/Tracktion dependency — std only.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    struct ClipGeom
    {
        double start = 0.0;
        double end = 0.0;
        double offset = 0.0;   // source read-in point (seconds into the source)

        double length() const { return end - start; }
        bool isValid() const { return end > start && offset >= -1e-9; }

        bool approxEquals (const ClipGeom& o, double eps = 1e-9) const
        {
            return std::abs (start - o.start) < eps
                && std::abs (end - o.end) < eps
                && std::abs (offset - o.offset) < eps;
        }
    };

    // Move the whole clip by `delta` seconds. Length and source offset are
    // unchanged; the clip can't start before `minStart` (default 0) — when it would,
    // it's clamped there (length preserved), which is the conventional DAW behavior.
    inline ClipGeom moveBy (ClipGeom c, double delta, double minStart = 0.0)
    {
        const double len = c.length();
        const double ns = std::max (minStart, c.start + delta);
        return { ns, ns + len, c.offset };
    }

    // Trim the left edge to `newStart`. The source offset shifts with the edge so the
    // material under the playhead doesn't slide. Fails (nullopt) if it would invert
    // the clip or read before the source start.
    inline std::optional<ClipGeom> trimStart (ClipGeom c, double newStart)
    {
        if (newStart >= c.end)
            return std::nullopt;                       // would invert / zero-length
        const double newOffset = c.offset + (newStart - c.start);
        if (newOffset < -1e-9)
            return std::nullopt;                       // before the source's start
        return ClipGeom { newStart, c.end, newOffset };
    }

    // Trim the right edge to `newEnd`. Offset unchanged. Fails if it would invert.
    inline std::optional<ClipGeom> trimEnd (ClipGeom c, double newEnd)
    {
        if (newEnd <= c.start)
            return std::nullopt;
        return ClipGeom { c.start, newEnd, c.offset };
    }

    // Split at absolute timeline time `t`. Returns {left, right}; the right piece's
    // offset advances by the consumed source length so playback is seamless. Fails
    // if `t` is not strictly inside the clip.
    inline std::optional<std::pair<ClipGeom, ClipGeom>> splitAt (ClipGeom c, double t)
    {
        if (t <= c.start || t >= c.end)
            return std::nullopt;
        ClipGeom left  { c.start, t, c.offset };
        ClipGeom right { t, c.end, c.offset + (t - c.start) };
        return std::make_pair (left, right);
    }
}
