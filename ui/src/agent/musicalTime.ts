// One unit contract shared by every Moshi prompt arm. Section and annotation
// commands use quarter-note beat offsets; clip, transport and render-region
// commands explicitly label their second-valued arguments in the catalog.
export const MUSICAL_TIME_RULE =
  "- Musical positions named beat/startBeat/endBeat are quarter-note beat offsets from project start, NEVER seconds. Bar N is one-based and starts at (N - 1) × numerator × 4 ÷ denominator beats; in 4/4 four bars span 16 beats (bar 1 to bar 5 = beats 0 to 16), regardless of tempo. Convert beats to seconds only for arguments explicitly labeled seconds.";
