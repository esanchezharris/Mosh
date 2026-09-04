// Shared monochrome line-icons — clean SVG, currentColor, so they inherit the button's
// color and theme automatically (no emoji, no raster). 24-unit grid, 1.7 stroke. Used to
// replace the old emoji glyphs (the yellow ear, speaker, mic, camera) across the shells.

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  );
}

export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}

export function IconX(p: IconProps) {
  return <IconClose {...p} />;
}

export function IconMore(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconArrowUp(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 18V6" />
      <path d="M7.5 10.5L12 6l4.5 4.5" />
      <path d="M5 19h14" />
    </Svg>
  );
}

export function IconChevronLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14.5 6.5L9 12l5.5 5.5" />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 6.5L15 12l-5.5 5.5" />
    </Svg>
  );
}

export function IconFolder(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h4l1.8 2H18a2.5 2.5 0 0 1 2.5 2.5V16A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16z" />
    </Svg>
  );
}

export function IconDrum(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4.5" y="5" width="6" height="6" rx="1.4" />
      <rect x="13.5" y="5" width="6" height="6" rx="1.4" />
      <rect x="4.5" y="13" width="6" height="6" rx="1.4" />
      <rect x="13.5" y="13" width="6" height="6" rx="1.4" />
    </Svg>
  );
}

export function IconLayers(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4.5l8 4.2-8 4.2-8-4.2z" />
      <path d="M5.5 12.2L12 15.8l6.5-3.6" opacity="0.78" />
      <path d="M5.5 15.6L12 19.2l6.5-3.6" opacity="0.55" />
    </Svg>
  );
}

export function IconSettings(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 4.5v2" />
      <path d="M12 17.5v2" />
      <path d="M4.5 12h2" />
      <path d="M17.5 12h2" />
      <path d="M6.8 6.8l1.4 1.4" />
      <path d="M15.8 15.8l1.4 1.4" />
      <path d="M17.2 6.8l-1.4 1.4" />
      <path d="M8.2 15.8l-1.4 1.4" />
    </Svg>
  );
}

export function IconWaveform(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 12h2l1.5-4 3 8 2.5-10 2.5 12 1.5-6h4" />
    </Svg>
  );
}

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 7.5l8 4.5-8 4.5z" fill="currentColor" stroke="currentColor" />
    </Svg>
  );
}

export function IconPause(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="7" y="6.5" width="3.5" height="11" rx="1" fill="currentColor" stroke="currentColor" />
      <rect x="13.5" y="6.5" width="3.5" height="11" rx="1" fill="currentColor" stroke="currentColor" />
    </Svg>
  );
}

export function IconStop(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="currentColor" />
    </Svg>
  );
}

export function IconSkipStart(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 7v10" />
      <path d="M10 12l7-4.5v9z" fill="currentColor" stroke="currentColor" />
    </Svg>
  );
}

export function IconUsers(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="9" cy="9" r="2.5" />
      <circle cx="16.5" cy="10.5" r="2" opacity="0.7" />
      <path d="M4.5 18a4.5 4.5 0 0 1 9 0" />
      <path d="M14 18a3.5 3.5 0 0 1 5-2.8" opacity="0.7" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5.5 12.5l4 4L18.5 7.5" />
    </Svg>
  );
}

export function IconPhone(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="8" y="3.5" width="8" height="17" rx="2" />
      <path d="M10.5 6.5h3" opacity="0.7" />
      <circle cx="12" cy="17.5" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconQuestion(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.8 9.7a2.4 2.4 0 1 1 4.1 1.8c-.8.7-1.9 1.3-1.9 2.5" />
      <circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconHelp(p: IconProps) {
  return <IconQuestion {...p} />;
}

export function IconMoon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15.5 4.8a7.2 7.2 0 1 0 3.7 12.3A7.8 7.8 0 0 1 15.5 4.8z" />
    </Svg>
  );
}

export function IconSun(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.2" />
      <path d="M12 18.3v2.2" />
      <path d="M3.5 12h2.2" />
      <path d="M18.3 12h2.2" />
      <path d="M5.9 5.9l1.6 1.6" />
      <path d="M16.5 16.5l1.6 1.6" />
      <path d="M18.1 5.9l-1.6 1.6" />
      <path d="M7.5 16.5l-1.6 1.6" />
    </Svg>
  );
}

export function IconDownload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v9" />
      <path d="M8 11.5L12 15.5l4-4" />
      <path d="M5 19h14" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M19 8a7 7 0 1 0 1 6.5" />
      <path d="M19 4v4h-4" />
    </Svg>
  );
}

export function IconList(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 7h11" />
      <path d="M8 12h11" />
      <path d="M8 17h11" />
      <circle cx="4.5" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="17" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSpark(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4.5l1.4 4.1L17.5 10l-4.1 1.4L12 15.5l-1.4-4.1L6.5 10l4.1-1.4z" />
    </Svg>
  );
}

export function IconStar(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4.8l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 10l5-.7z" fill="currentColor" stroke="currentColor" />
    </Svg>
  );
}

export function IconStarOutline(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4.8l2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 10l5-.7z" />
    </Svg>
  );
}

// push-to-talk microphone
export function IconMic(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <path d="M12 17v3.5" />
      <path d="M9 20.5h6" />
    </Svg>
  );
}

export function IconSpeaker(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" stroke="currentColor" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
      <path d="M18 6.8a7.2 7.2 0 0 1 0 10.4" opacity="0.7" />
    </Svg>
  );
}

export function IconSpeakerMute(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" stroke="currentColor" />
      <path d="M16 9.5l5 5" />
      <path d="M21 9.5l-5 5" />
    </Svg>
  );
}

export function IconCamera(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="7" width="12" height="10" rx="2.5" />
      <path d="M15 10.5l5.5-3v9l-5.5-3z" />
    </Svg>
  );
}

export function IconCameraOff(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 7.5A2 2 0 0 1 5 7h8a2 2 0 0 1 2 2v1.5" />
      <path d="M15 13.5V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9" opacity="0.85" />
      <path d="M15 10.5l5.5-3v9l-3-1.6" />
      <path d="M4 4l16 16" />
    </Svg>
  );
}

// ── track icons (CAP-TRK-002 / #613) ────────────────────────────────────────────────
// These ship at 16px in the track header, which is the size that governs every choice
// below: at 16px an outline loses its interior and only the SILHOUETTE survives. So the
// three "it's a waveform" instruments are separated by structure rather than by detail —
// bass is one smooth low period, sample is discrete vertical slices, synth is angular saw
// teeth — because three tastefully different squiggles would be one indistinguishable
// squiggle in the header. `drum` reuses IconDrum (the MPC pad grid), `vocal` reuses
// IconMic and `fx` reuses IconSpark; only the seven with no existing glyph are new.

// tambourine — a ring with jingles. Deliberately round where IconDrum is square, so
// "beat" and "tops" don't collapse into each other at a glance.
export function IconPerc(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="4.6" r="1.3" />
      <circle cx="18.4" cy="15.7" r="1.3" />
      <circle cx="5.6" cy="15.7" r="1.3" />
    </Svg>
  );
}

// the low end — one full, slow, tall period. The only smooth curve in the set.
export function IconBass(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 12c0-4.5 2.4-6.5 4.75-6.5S12 7.5 12 12s2.4 6.5 4.75 6.5S21.5 16.5 21.5 12" />
    </Svg>
  );
}

// figure-8 body + neck. The one instrument outline that survives 16px, because the
// waist is the whole read.
export function IconGuitar(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.7 10.6a3.4 3.4 0 1 0-2.6 5.8 3.9 3.9 0 1 0 4.1 3.1 3.5 3.5 0 0 0-1.5-8.9z" />
      <path d="M12.2 11.4L19 4.6" />
      <path d="M17.6 3.2l3.2 3.2" />
    </Svg>
  );
}

// a keybed seen head-on: the two black-key clusters are what make it unmistakable.
export function IconKeys(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="6.5" width="18" height="11" rx="1.6" />
      <path d="M8.25 6.5v11" />
      <path d="M12 6.5v11" />
      <path d="M15.75 6.5v11" />
      <path d="M6.6 6.5v4.4M9.9 6.5v4.4M14.1 6.5v4.4M17.4 6.5v4.4" />
    </Svg>
  );
}

// sawtooth — angular where bass is smooth. Reads "oscillator", not "recording".
export function IconSynth(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 17L8 7v10l5-10v10l5-10v10h3" />
    </Svg>
  );
}

// a harp/lyre: an arc with strings under it. No other icon here has parallel verticals
// under a curve, which is the whole point.
export function IconStrings(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 19.5C5 9.5 19 9.5 19 19.5" />
      <path d="M4 19.5h16" />
      <path d="M8.5 19.5v-6.2M12 19.5v-7.4M15.5 19.5v-6.2" />
    </Svg>
  );
}

// chopped audio — discrete slices, not a continuous line. The bracket says "a region of
// a file" rather than "a signal".
export function IconSample(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 8.5v7M7.7 6v12M11.4 9.5v5M15.1 7v10M18.8 10v4" />
    </Svg>
  );
}
