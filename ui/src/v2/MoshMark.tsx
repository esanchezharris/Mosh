// The Mosh brand mark — the minimized Moshi: a puffy 5-petal splat with a "> <" squint and
// a rounded lime singing mouth (the concept art). Authored inline so it themes itself via
// overridable vars: the body takes --v2-mark-fill (defaults to the ground TEXT color so it
// contrasts the page — a dark blob on cream, a pale blob on the dark hero), a soft sticker
// rim sits behind it, the eyes knock out in --v2-mark-face (the ground/panel color), and the
// mouth keeps the brand lime with a dark throat. Static (the one animated mount is the WebGL
// Moshi in the rail). Used in the topbar top-left, the composer prompt bar, and the agent tab.
//
// The body silhouette is the union of overlapping circles (puffy, round lobes) — both the rim
// and the fill are drawn as that union so there are no internal seams.

export function MoshMark({ size = 30, className }: { size?: number; className?: string }) {
  // 5 lobe circles around the center (every 72°, starting at the top) + a center circle.
  const lobes = [
    [50, 30],
    [69.0, 43.8],
    [61.8, 66.2],
    [38.2, 66.2],
    [31.0, 43.8],
  ] as const;
  return (
    <svg
      className={`v2-mark${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Mosh"
    >
      {/* soft outline rim (sticker edge) — the same union, slightly larger, behind the body */}
      <g fill="var(--v2-mark-rim, rgba(248, 245, 236, 0.85))">
        {lobes.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={24.5} />)}
        <circle cx={50} cy={50} r={25.5} />
      </g>
      {/* body — union of circles = a puffy 5-petal flower */}
      <g fill="var(--v2-mark-fill, var(--v2-ground-text))">
        {lobes.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={22} />)}
        <circle cx={50} cy={50} r={23} />
      </g>
      {/* gloss highlights */}
      <g fill="none" stroke="var(--v2-mark-hi, rgba(255, 255, 255, 0.32))" strokeWidth="2.2" strokeLinecap="round">
        <path d="M30 34 Q40 26 54 28" />
        <path d="M27 50 Q30 60 38 64" />
      </g>
      {/* the "> <" squint — knocked out in the page (or panel) color */}
      <g
        fill="none"
        stroke="var(--v2-mark-face, var(--v2-ground))"
        strokeWidth="5.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="37,41 45,47.5 37,54" />
        <polyline points="63,41 55,47.5 63,54" />
      </g>
      {/* the rounded lime singing mouth + a dark throat */}
      <path
        d="M41 58 Q50 56.3 59 58 Q60.6 66.4 53.5 70.8 Q50 72.8 46.5 70.8 Q39.4 66.4 41 58 Z"
        fill="var(--v2-mark-mouth, var(--v2-accent))"
      />
      <ellipse cx="50" cy="65.5" rx="4" ry="5" fill="var(--v2-mark-throat, var(--v2-accent-ink))" />
    </svg>
  );
}
