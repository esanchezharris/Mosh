// The Mosh brand mark — the minimized Moshi: a glossy 5-petal splat with a "> <" squint
// and a lime open singing mouth (the concept art). Authored inline so it themes itself via
// overridable vars: the body takes --v2-mark-fill (defaults to the ground TEXT color so it
// contrasts the page — a dark blob on cream, a pale blob on the dark hero), the eyes + throat
// knock out in --v2-mark-face (the ground/panel color), and the mouth keeps the brand lime.
// Static (the one animated mount is the WebGL Moshi in the rail). Used in the topbar top-left,
// the composer prompt bar, and the collapsed agent-dock tab.

export function MoshMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`v2-mark${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="-10 -10 140 140"
      role="img"
      aria-label="Mosh"
    >
      {/* the 5-petal splat body (smooth quadratic lobes) */}
      <path
        d="M80 32.5 Q122.8 39.6 92.3 70.5 Q98.8 113.4 60 94 Q21.2 113.4 27.7 70.5 Q-2.8 39.6 40 32.5 Q60 -6 80 32.5 Z"
        fill="var(--v2-mark-fill, var(--v2-ground-text))"
      />
      {/* soft gloss highlight */}
      <path
        d="M34 30 Q46 20 66 23"
        fill="none"
        stroke="var(--v2-mark-hi, rgba(255, 255, 255, 0.4))"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* the "> <" squint — knocked out in the page (or panel) color */}
      <g
        fill="none"
        stroke="var(--v2-mark-face, var(--v2-ground))"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="50,52 57,58.5 50,65" />
        <polyline points="70,52 63,58.5 70,65" />
      </g>
      {/* the open singing mouth — lime pop, flat top + round bottom, with a knocked-out throat */}
      <path d="M47 72 L73 72 A13 13 0 0 1 47 72 Z" fill="var(--v2-mark-mouth, var(--v2-accent))" />
      <ellipse cx="60" cy="83" rx="5.6" ry="4.4" fill="var(--v2-mark-face, var(--v2-ground))" />
    </svg>
  );
}
