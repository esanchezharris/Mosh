// ============================================================================
// THE MOSH DESIGN KIT — v2 tokens, extracted verbatim from ui/src/v2/shell.css.
// This is the SINGLE SOURCE OF TRUTH candidates render against AND winners port
// back into. Keep in sync with shell.css by copy (it's small; documented in README).
// Every candidate doc gets `tokensCss(theme)` injected so `var(--v2-accent)` etc.
// resolve exactly as they do in the real shell → a winner drops in with no translation.
// ============================================================================

export type Theme = "dark" | "light";

export const FONTS = {
  display: `"NanumSquareRound", "Archivo Black", "Helvetica Neue", "Arial Black", sans-serif`,
  body: `-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`,
  mono: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
};

// Geometry + type + spacing + radius — theme-invariant.
const STRUCT: Record<string, string> = {
  "--v2-head-w": "168px",
  "--v2-lane-h": "64px",
  "--v2-ribbon-h": "40px",
  "--v2-ruler-h": "24px",
  "--v2-topbar-h": "64px",
  "--v2-radius": "16px",
  "--v2-radius-sm": "10px",
  "--v2-radius-xs": "4px",
  "--v2-radius-md": "8px",
  "--v2-radius-lg": "12px",
  "--v2-radius-pill": "999px",
  "--v2-gap": "14px",
  "--v2-rail-w": "286px",
  "--v2-browser-w": "340px",
  "--v2-tab-w": "46px",
  "--v2-stage-max": "1000px",
  "--v2-fs-2xs": "9px",
  "--v2-fs-xs": "10px",
  "--v2-fs-sm": "11px",
  "--v2-fs-base": "13px",
  "--v2-fs-md": "15px",
  "--v2-fs-lg": "17px",
  "--v2-fs-xl": "20px",
  "--v2-fs-display": "40px",
  "--v2-tracking-caps": "0.14em",
  "--v2-space-1": "2px",
  "--v2-space-2": "4px",
  "--v2-space-3": "6px",
  "--v2-space-4": "8px",
  "--v2-space-5": "10px",
  "--v2-space-6": "12px",
  "--v2-space-7": "16px",
  "--v2-space-8": "24px",
};

// Dark "Midnight Drive" hero — the default.
export const DARK: Record<string, string> = {
  "--v2-bg": "radial-gradient(130% 90% at 50% -10%, #161616 0%, #0c0c0c 52%, #050505 100%)",
  "--v2-ink": "#0a0a0a",
  "--v2-surface": "rgba(24, 24, 25, 0.64)",
  "--v2-surface-2": "rgba(33, 33, 35, 0.74)",
  "--v2-surface-sunken": "rgba(12, 12, 13, 0.62)",
  "--v2-line": "rgba(255, 255, 255, 0.09)",
  "--v2-line-strong": "rgba(255, 255, 255, 0.18)",
  "--v2-text": "#ededee",
  "--v2-dim": "rgba(232, 232, 234, 0.56)",
  "--v2-faint": "rgba(220, 220, 224, 0.34)",
  "--v2-accent": "#ccff36",
  "--v2-accent-ink": "#0a0f04",
  "--v2-accent-soft": "rgba(204, 255, 54, 0.13)",
  "--v2-blue": "#9aa0b4",
  "--v2-clip-wave": "linear-gradient(180deg, rgba(78, 82, 96, 0.92), rgba(54, 57, 68, 0.82))",
  "--v2-clip-midi": "rgba(196, 202, 220, 0.82)",
  "--v2-clip-drum": "rgba(204, 255, 54, 0.7)",
  "--v2-clip-block": "linear-gradient(180deg, rgba(70, 72, 84, 0.9), rgba(50, 52, 62, 0.8))",
  "--v2-playhead": "#ccff36",
  "--v2-rec": "#ff3b5c",
  "--v2-shadow": "0 18px 50px rgba(0, 0, 0, 0.6)",
  "--v2-glow": "0 0 0 1px rgba(255,255,255,0.09), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
  "--v2-ground": "#0c0c0c",
  "--v2-ground-text": "#ededee",
  "--v2-ground-dim": "rgba(232, 232, 234, 0.56)",
  "--v2-ground-card": "rgba(33, 33, 35, 0.74)",
  "--v2-ground-line": "rgba(255, 255, 255, 0.09)",
  "--v2-ground-line-strong": "rgba(255, 255, 255, 0.18)",
  "--status-ok": "#3fe06a",
  "--status-warn": "#ffd45c",
};

// Light "cream" — warm paper PAGE, DARK content panels, brighter lime.
export const LIGHT: Record<string, string> = {
  ...DARK,
  "--v2-bg": "radial-gradient(135% 105% at 50% -8%, #f7f1e6 0%, #f1ebde 52%, #ebe3d2 100%)",
  "--v2-surface": "#1b1b1d",
  "--v2-surface-2": "#242427",
  "--v2-surface-sunken": "#141416",
  "--v2-text": "#f0efe9",
  "--v2-dim": "rgba(240, 239, 233, 0.58)",
  "--v2-faint": "rgba(236, 234, 226, 0.34)",
  "--v2-accent": "#c2f53f",
  "--v2-accent-ink": "#16210a",
  "--v2-accent-soft": "rgba(194, 245, 63, 0.16)",
  "--v2-blue": "#a7adba",
  "--v2-clip-drum": "rgba(194, 245, 63, 0.7)",
  "--v2-playhead": "#c2f53f",
  "--v2-shadow": "0 22px 50px rgba(70, 56, 28, 0.18)",
  "--v2-ground": "#f1ebde",
  "--v2-ground-text": "#17150f",
  "--v2-ground-dim": "rgba(23, 21, 15, 0.56)",
  "--v2-ground-card": "#fffdf6",
  "--v2-ground-line": "rgba(34, 26, 12, 0.14)",
  "--v2-ground-line-strong": "rgba(34, 26, 12, 0.26)",
};

export function tokens(theme: Theme): Record<string, string> {
  return { ...STRUCT, ...(theme === "light" ? LIGHT : DARK) };
}

/** A `:root { … }` CSS block defining every kit token for the given theme, plus the
 *  semantic role aliases the shell derives. Injected into candidate documents. */
export function tokensCss(theme: Theme): string {
  const t = tokens(theme);
  const decls = Object.entries(t)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `:root {
${decls}
  --accent: var(--v2-accent);
  --accent-ink: var(--v2-accent-ink);
  --accent-soft: var(--v2-accent-soft);
  --font-display: ${FONTS.display};
  --font-body: ${FONTS.body};
  --font-mono: ${FONTS.mono};
}`;
}
