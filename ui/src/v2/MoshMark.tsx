// The Mosh brand mark — a 5-petal Moshi flower with the "> <" face, authored inline so
// it themes itself: the petals take the ground TEXT color (ink on cream / light on the
// dark hero) and the face knocks out in the page GROUND color, so it reads in both
// themes with zero assets. No raster, no network. Used in the topbar + the composer.

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
      {/* the "> <" eyes + grin, knocked out in the page (or panel) color */}
      <g
        fill="none"
        stroke="var(--v2-mark-face, var(--v2-ground))"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="12.4,13.4 14.7,15.4 12.4,17.4" />
        <polyline points="19.6,13.4 17.3,15.4 19.6,17.4" />
        <path d="M13 19.6 Q16 22 19 19.6" />
      </g>
    </svg>
  );
}
