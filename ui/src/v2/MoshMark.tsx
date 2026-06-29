// The Mosh brand mark — a tiny 5-petal Moshi flower with the "> <" squint + a lime singing
// mouth, echoing the minimized MoshBlob in the rail. Authored inline so it themes itself:
// the petals take the ground TEXT color (ink on cream / light on the dark hero), the eyes
// knock out in the ground color, and the open mouth keeps the brand lime in both themes.
// No raster, no network, no animation — the one animated mount is MoshBlob. Used in the
// topbar + the composer.

export function MoshMark({ size = 30, className }: { size?: number; className?: string }) {
  // 5 petal circles around the center (every 72°, starting at the top), overlapping into
  // a rounded flower. Centers precomputed so the SVG is static markup.
  const petals = [
    [16, 9.5],
    [22.18, 14.0],
    [19.82, 21.26],
    [12.18, 21.26],
    [9.82, 14.0],
  ] as const;
  return (
    <svg
      className={`v2-mark${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Mosh"
    >
      <g fill="var(--v2-mark-fill, var(--v2-ground-text))">
        {petals.map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r={7} />
        ))}
        <circle cx={16} cy={16} r={7} />
      </g>
      {/* the "> <" squint — knocked out in the page (or panel) color */}
      <g
        fill="none"
        stroke="var(--v2-mark-face, var(--v2-ground))"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="12.2,13.0 14.6,15.2 12.2,17.4" />
        <polyline points="19.8,13.0 17.4,15.2 19.8,17.4" />
      </g>
      {/* the open singing mouth — lime pop (matches MoshBlob), flat top + round bottom */}
      <path
        d="M13.4 18.6 L18.6 18.6 A2.6 2.6 0 0 1 13.4 18.6 Z"
        fill="var(--v2-mark-mouth, var(--v2-accent))"
      />
    </svg>
  );
}
