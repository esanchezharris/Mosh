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

// hands-free "always-on listening" — a sensor/broadcast mark (center dot + arcs)
export function IconListen(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8" />
      <path d="M15.9 8.1a5.5 5.5 0 0 1 0 7.8" />
      <path d="M5.5 5.5a9.2 9.2 0 0 0 0 13" opacity="0.5" />
      <path d="M18.5 5.5a9.2 9.2 0 0 1 0 13" opacity="0.5" />
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
