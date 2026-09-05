// ============================================================================
// Declarative settings schema — the SINGLE source of truth for app settings.
// allow: SIZE_OK — this file is the intentionally centralized pure-data settings table.
//
// Settings/skins/templates are UI presentation, so they live UI-LOCAL (persisted
// to localStorage by settings/store.ts), NEVER as backend commands — the swappable
// seam stays clean (the C++/Tracktion backend has zero knowledge of any of this).
// The lone exception is the ENGINE block (buffer size, audio threads, sample rate),
// which is backend state read from the snapshot and mutated through its existing
// MoshOps commands; those are intentionally NOT in this schema.
//
// Add a descriptor here and it renders itself in the Settings panel automatically
// (settings/SettingsPanel.tsx has one renderer per `type`). Start with app scope.
// ============================================================================

import { type EditorAction } from "../interaction/actions";
import { REBINDABLE_ACTIONS } from "../interaction/keymap";
import { FEEL_DEFAULTS } from "../interaction/feel";

export type SettingType =
  | "enum"
  | "bool"
  | "number"
  | "key"
  | "gesture-table";

export type SettingScope = "app" | "session" | "track";

export type SettingValue = string | number | boolean;

export interface EnumOption {
  value: string;
  label: string;
}

export interface SettingConstraints {
  min?: number;
  max?: number;
  step?: number;
  options?: EnumOption[]; // for `enum`
}

export interface SettingDef {
  id: string;
  type: SettingType;
  default: SettingValue;
  scope: SettingScope;
  category: string;
  label: string;
  help?: string;
  constraints?: SettingConstraints;
}

const PROTOOLS_FADE_CURVE_OPTIONS: EnumOption[] = [
  { value: "linear", label: "Linear" },
  { value: "convex", label: "Convex" },
  { value: "concave", label: "Concave" },
  { value: "sCurve", label: "S-Curve" },
];

// The descriptors. Grouped by category in the UI, in array order.
export const SETTINGS: SettingDef[] = [
  {
    id: "skin",
    type: "enum",
    default: "mosh",
    scope: "app",
    category: "Appearance",
    label: "Skin",
    help: "Token set that reskins the whole UI. Independent of light/dark.",
    constraints: {
      options: [
        { value: "mosh", label: "Mosh" },
        { value: "ableton", label: "Ableton" },
        { value: "fl", label: "FL" },
        { value: "protools", label: "Pro Tools" },
        { value: "logic", label: "Logic" },
      ],
    },
  },
  {
    id: "theme",
    type: "enum",
    default: "light",
    scope: "app",
    category: "Appearance",
    label: "Theme",
    help: "Light (warm cream + dark panels) or dark (Midnight Drive neon). An axis independent of skin.",
    constraints: {
      options: [
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" },
      ],
    },
  },
  {
    id: "uiScale",
    type: "number",
    default: 1,
    scope: "app",
    category: "Appearance",
    label: "UI scale",
    help: "Zooms the whole interface.",
    constraints: { min: 0.8, max: 1.4, step: 0.1 },
  },
  {
    id: "colorway",
    type: "enum",
    default: "lime",
    scope: "app",
    category: "Appearance",
    label: "Colorway",
    help: "Accent for selection, MIDI notes, and primary actions. Session content stays bone.",
    constraints: {
      options: [
        { value: "lime", label: "Lime" },
        { value: "bone", label: "Bone" },
        { value: "violet", label: "Violet" },
        { value: "coral", label: "Coral" },
      ],
    },
  },
  {
    id: "voiceOn",
    type: "bool",
    default: true,
    scope: "app",
    category: "Moshi",
    label: "Voice",
    help: "Moshi's voice earcons.",
  },
  {
    id: "voiceVol",
    type: "number",
    default: 0.55,
    scope: "app",
    category: "Moshi",
    label: "Voice volume",
    constraints: { min: 0, max: 1, step: 0.05 },
  },
  {
    id: "agentMemory",
    type: "bool",
    default: true,
    scope: "app",
    category: "Moshi",
    label: "Agent memory (experimental)",
    help: "Moshi recalls preferences and patterns it's learned, plus this project's own notes, and folds a few relevant ones into its thinking each turn. Off = no recall.",
  },
  {
    id: "agentConfirmDestructive",
    type: "bool",
    default: true,
    scope: "app",
    category: "Moshi",
    label: "Confirm destructive",
    help: "Ask before Moshi runs a destructive edit (delete clip, remove bus, etc.).",
  },
  {
    id: "produceLane",
    type: "bool",
    default: false,
    scope: "app",
    category: "Moshi",
    label: "Produce mode (experimental)",
    help: "An explicit 'produce me a beat' / 'full beat' ask gets a full production pass: bigger budgets and the genre rules learned from real correction rounds, building an 8-12 track A/B arrangement with real sounds. Off = every ask stays a bounded assistant edit.",
  },
  {
    id: "layout",
    type: "enum",
    default: "mosh",
    scope: "app",
    category: "Layout",
    label: "Panel layout",
    help: "Fixed zones (browser-left · arrange-center · dock-bottom). FL also pops the drum sequencer into a floating window.",
    constraints: {
      options: [
        { value: "mosh", label: "Mosh" },
        { value: "ableton", label: "Ableton" },
        { value: "fl", label: "FL" },
        { value: "protools", label: "Pro Tools" },
        { value: "logic", label: "Logic" },
      ],
    },
  },
  {
    id: "redesignShell",
    type: "bool",
    default: true,
    scope: "app",
    category: "Layout",
    label: "Redesign shell",
    help: "The agent-first shell: Session rail (Moshi + collaborators + Inspector), section navigator, per-track FX drawers, the bottom prompt bar + the “+” file/options control, timeline annotations, and collaborator video. On by default; turn it off for the classic layout.",
  },
  {
    // The from-scratch demo-driven shell (ui/src/v2). A first-class axis, NOT a
    // variant of redesignShell: "classic" = the prior App; "v2" = the new Mosh shell;
    // "live" = the Live-12 Arrangement-View clone (ui/src/live); "protools" = the
    // Pro Tools Edit-Window-inspired shell (ui/src/protools). UI-local + reversible
    // (flip back anytime, here or via the in-app toggle). PRO TOOLS is the DEFAULT for
    // fresh settings as of the 2026-08-09 session-readiness cutover; existing explicit
    // preferences remain persisted, and Live/v2/classic stay fully available. In
    // dev/e2e a `?shell=` query-param overrides this per page-load (see v2/shellQuery.ts).
    id: "uiShell",
    type: "enum",
    default: "protools",
    scope: "app",
    category: "Layout",
    label: "Interface",
    help: "Which interface to use. “Pro Tools” is the fresh-install default; “Live (clone),” “Mosh,” and “Classic” remain available, and an existing choice is preserved.",
    constraints: {
      options: [
        { value: "classic", label: "Classic" },
        { value: "v2", label: "Mosh (new)" },
        // The additive Live-12 Arrangement-View clone (ui/src/live). Same store/seam,
        // same reversible flip — picking it here (or the "Live (clone)" template, or
        // ?shell=live in dev/e2e) mounts AppLive; classic and v2 are untouched.
        { value: "live", label: "Live (clone)" },
        { value: "protools", label: "Pro Tools" },
        { value: "v3", label: "Mosh (v3)" },
      ],
    },
  },
  {
    id: "protoolsDefaultFadeLengthMs",
    type: "number",
    default: 10,
    scope: "app",
    category: "Pro Tools",
    label: "Default fade length",
    help: "Edge length used by the Pro Tools no-dialog fade shortcut and remembered after a successful Fades dialog Apply, in milliseconds.",
    constraints: { min: 0, max: 60_000, step: 1 },
  },
  {
    id: "protoolsDefaultFadeCurveIn",
    type: "enum",
    default: "linear",
    scope: "app",
    category: "Pro Tools",
    label: "Default fade-in shape",
    help: "Fade-in shape used by the Pro Tools no-dialog fade shortcut and remembered after a successful Fades dialog Apply.",
    constraints: { options: PROTOOLS_FADE_CURVE_OPTIONS },
  },
  {
    id: "protoolsDefaultFadeCurveOut",
    type: "enum",
    default: "linear",
    scope: "app",
    category: "Pro Tools",
    label: "Default fade-out shape",
    help: "Fade-out shape used by the Pro Tools no-dialog fade shortcut and remembered after a successful Fades dialog Apply.",
    constraints: { options: PROTOOLS_FADE_CURVE_OPTIONS },
  },
  {
    // Opt-in crash reporting + anonymous usage telemetry (src/telemetry/, see
    // docs/telemetry/PRIVACY.md). Default OFF. The one side effect of toggling
    // this is a native call (bridge.ts's setTelemetryOptIn, wired from
    // effects.ts) that creates/removes a small flag file
    // (~/Library/Mosh/telemetry.optin) the native crash handler + counters read
    // directly — deliberately NOT a MoshOps command. No network of any kind
    // happens unless this is on.
    id: "telemetryOptIn",
    type: "bool",
    default: false,
    scope: "app",
    category: "Privacy",
    label: "Share crash reports & usage",
    help: "Off by default. When on, Mosh may send anonymous crash reports and command-usage counts (command NAMES only — never audio, lyrics, file paths, or project content) to help find and fix bugs. No network activity happens while this is off.",
  },
  ...interactionSettings(),
  {
    // The live shell's detail-dock height (points), written by the dock's drag
    // splitter so the layout survives a reload. The persisted bounds here are broad;
    // the runtime clamp (min 226, max 70% of the shell) lives in live/dockGeometry.ts.
    id: "liveDockHeight",
    type: "number",
    default: 265,
    scope: "app",
    category: "Layout",
    label: "Live dock height",
    help: "Detail-dock height in the Live (clone) interface, in points. Set by dragging the divider above the dock.",
    constraints: { min: 120, max: 800, step: 1 },
  },
  {
    // Live's Expanded Clip View (⌥⌘E): the docked editor consumes the whole window
    // (browser/arrangement/headers hidden). STICKY across close/reopen of the clip
    // view, like Live — hence a persisted setting rather than shell view state.
    id: "liveClipExpanded",
    type: "bool",
    default: false,
    scope: "app",
    category: "Layout",
    label: "Live: expanded clip view",
    help: "The docked editor fills the whole window in the Live (clone) interface.",
  },
  {
    // AUD-SCAN — opt-in AudioUnit cataloging. Off by default because an AU sweep is the
    // slow/risky path (a hung component is killed by the ~25 s stall watchdog, a crashed
    // one is quarantined by the dead-man's pedal), so first launch stays fast and safe.
    // Until this existed the ONLY way in was the MOSH_SCAN_AU env var, set in exactly one
    // place in the tree (Main.cpp, for --scan-plugins-deep) — so the shipped app could
    // never catalog an AudioUnit at all. Last in the schema on purpose: this is
    // maintenance, not a preference, so it sits at the bottom of the settings panel.
    id: "scanAudioUnits",
    type: "bool",
    default: false,
    scope: "app",
    category: "Plugins",
    label: "Scan Audio Units",
    help: "Include AudioUnit (AU) plugins when re-scanning. Slower than VST3, and a badly-behaved component can stall the scan — hung plugins are killed and quarantined automatically. Turn this on if your instruments are AU-only.",
  },
];

// ── Interaction settings (Phase: DAW-faithful controls). The gesture-table + keymap
// SELECTORS pick a DAW preset; the feel sliders tune continuous behavior; the key.*
// settings rebind individual actions (empty = inherit the keymap preset). All are
// template values, so switching to the Ableton template loads its whole feel.
// (Data lives inside the function so there's no temporal-dead-zone hazard from the
// `...interactionSettings()` spread during the SETTINGS initializer above.)
function interactionSettings(): SettingDef[] {
  const DAW_OPTIONS: EnumOption[] = [
    { value: "mosh", label: "Mosh" },
    { value: "ableton", label: "Ableton" },
    { value: "fl", label: "FL" },
    { value: "protools", label: "Pro Tools" },
    { value: "logic", label: "Logic" },
  ];
  const FEEL_META: { id: keyof typeof FEEL_DEFAULTS; label: string; help: string; min: number; max: number; step: number }[] = [
    { id: "dragThreshold", label: "Drag threshold (px)", help: "Movement before a click becomes a drag.", min: 0, max: 20, step: 1 },
    { id: "doubleClickMs", label: "Double-click (ms)", help: "Max gap between two clicks to open a clip.", min: 150, max: 600, step: 10 },
    { id: "edgeGrabPx", label: "Edge-grab zone (px)", help: "Width of the clip trim zones.", min: 2, max: 24, step: 1 },
    { id: "snapStrength", label: "Snap strength", help: "0 = free, 1 = always snap to grid.", min: 0, max: 1, step: 0.05 },
    { id: "zoomSensitivity", label: "Zoom sensitivity", help: "Wheel-zoom gain (Mod+wheel).", min: 0.25, max: 3, step: 0.05 },
    { id: "scrollSensitivity", label: "Scroll sensitivity", help: "Wheel-scroll gain.", min: 0.25, max: 3, step: 0.05 },
  ];
  const KEY_LABELS: Partial<Record<EditorAction, string>> = {
    play_pause: "Play / Pause", record: "Record", undo: "Undo", redo: "Redo",
    save: "Save", delete: "Delete", copy: "Copy", cut: "Cut", paste: "Paste",
    duplicate: "Duplicate", group: "Group", to_start: "To start", to_end: "To end",
    split: "Split at playhead", tool_move: "Move tool", tool_split: "Split tool",
    tool_range: "Range tool", nudge_left: "Nudge clip left", nudge_right: "Nudge clip right",
    felt_wrong: "Felt wrong (capture)", capture_midi: "Capture MIDI",
  };
  const selectors: SettingDef[] = [
    {
      id: "gestureTable", type: "enum", default: "mosh", scope: "app",
      category: "Interaction", label: "Mouse gestures",
      help: "Which DAW's clip/lane interaction model the mouse uses.",
      constraints: { options: DAW_OPTIONS },
    },
    {
      id: "keymap", type: "enum", default: "mosh", scope: "app",
      category: "Interaction", label: "Keymap",
      help: "Which DAW's keyboard shortcut set.",
      constraints: { options: DAW_OPTIONS },
    },
    {
      id: "prGridDivision", type: "enum", default: "1/16", scope: "app",
      category: "Interaction", label: "Piano-roll grid",
      help: "The MIDI editor's own grid, independent of the arrangement's — choosing 1/16 to place hi-hats no longer re-grids the whole session. Cmd+1..4 in the editor.",
      constraints: { options: [
        { value: "bar", label: "Bar" }, { value: "1/4", label: "1/4" }, { value: "1/8", label: "1/8" },
        { value: "1/16", label: "1/16" }, { value: "1/32", label: "1/32" },
      ] },
    },
    {
      id: "prGridAdaptive", type: "bool", default: true, scope: "app",
      category: "Interaction", label: "Adaptive piano-roll grid",
      help: "Let the editor's grid follow the zoom — the finest division whose lines are still far enough apart to aim at — instead of a fixed one.",
    },
    {
      id: "prGridTriplet", type: "bool", default: false, scope: "app",
      category: "Interaction", label: "Triplet grid",
      help: "Three notes in the space of two, in the MIDI editor. T in the editor.",
    },
    {
      id: "notePreview", type: "bool", default: true, scope: "app",
      category: "Interaction", label: "Hear notes as you edit",
      help: "Ableton's Preview switch. Plays a note through the track's instrument when you draw it, drag it to a new pitch, click a key in the piano-roll gutter, or select it. Needs an instrument on the track.",
    },
    {
      id: "scaleLock", type: "bool", default: false, scope: "app",
      category: "Interaction", label: "Scale lock",
      help: "In the piano roll, snap notes you draw or drag to the song key, and dim the out-of-key rows. Existing notes are never rewritten. Off by default — set the key in the topbar.",
    },
  ];
  const feel: SettingDef[] = FEEL_META.map((m) => ({
    id: `feel.${m.id}`, type: "number", default: FEEL_DEFAULTS[m.id], scope: "app",
    category: "Feel", label: m.label, help: m.help,
    constraints: { min: m.min, max: m.max, step: m.step },
  }));
  const keys: SettingDef[] = REBINDABLE_ACTIONS.map((a) => ({
    id: `key.${a}`, type: "key", default: "", scope: "app",
    category: "Keys", label: KEY_LABELS[a] ?? a,
    help: "Empty = use the keymap preset's binding.",
  }));
  return [...selectors, ...feel, ...keys];
}

export const SETTINGS_BY_ID: Record<string, SettingDef> = Object.fromEntries(
  SETTINGS.map((d) => [d.id, d]),
);

export function settingDef(id: string): SettingDef | undefined {
  return SETTINGS_BY_ID[id];
}

// The schema defaults as a flat map — the base every effective value layers over.
export function defaultSettings(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const d of SETTINGS) out[d.id] = d.default;
  return out;
}

export interface SettingCategory {
  category: string;
  settings: SettingDef[];
}

// Group the schema by category, categories in first-appearance order and settings
// in schema order within each — exactly how the panel renders itself. Add a setting
// to SETTINGS and it shows up in its category automatically.
export function settingsByCategory(): SettingCategory[] {
  const groups: SettingCategory[] = [];
  const byName = new Map<string, SettingCategory>();
  for (const d of SETTINGS) {
    let g = byName.get(d.category);
    if (!g) {
      g = { category: d.category, settings: [] };
      byName.set(d.category, g);
      groups.push(g);
    }
    g.settings.push(d);
  }
  return groups;
}

// Validate + clamp a value for `id`. The store funnels BOTH user input and
// anything read back from localStorage through this, so a corrupted / out-of-range
// persisted value can never poison state — it degrades to the schema default.
export function coerceSetting(id: string, value: SettingValue): SettingValue {
  const def = settingDef(id);
  if (!def) return value; // unknown id — nothing to validate against
  switch (def.type) {
    case "enum": {
      const opts = def.constraints?.options ?? [];
      return opts.some((o) => o.value === value) ? value : def.default;
    }
    case "bool":
      return typeof value === "boolean" ? value : def.default;
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return def.default;
      const { min, max, step } = def.constraints ?? {};
      let v = n;
      if (typeof min === "number") v = Math.max(min, v);
      if (typeof max === "number") v = Math.min(max, v);
      if (typeof step === "number" && step > 0) {
        const base = typeof min === "number" ? min : 0;
        v = base + Math.round((v - base) / step) * step;
        // re-clamp after snapping (a step can nudge past max/min) and tidy FP dust
        if (typeof min === "number") v = Math.max(min, v);
        if (typeof max === "number") v = Math.min(max, v);
        v = Math.round(v * 1e6) / 1e6;
      }
      return v;
    }
    case "key":
    case "gesture-table":
      return typeof value === "string" ? value : def.default;
    default:
      return def.default;
  }
}
