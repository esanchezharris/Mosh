// ============================================================================
// Declarative settings schema — the SINGLE source of truth for app settings.
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
    default: "dark",
    scope: "app",
    category: "Appearance",
    label: "Theme",
    help: "Light or dark ground. An axis independent of skin.",
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
    id: "handsFree",
    type: "bool",
    default: false,
    scope: "app",
    category: "Moshi",
    label: "Hands-free",
    help: "Always-on listening: Moshi acts on command phrases (“redo that”, “let me hear that”, “stop”) without holding the mic. The mic is hot only while this is on.",
  },
  {
    id: "handsFreePauseOnRecord",
    type: "bool",
    default: false,
    scope: "app",
    category: "Moshi",
    label: "Pause hands-free while recording",
    help: "Fallback for audio inputs that can’t be shared: while a take is recording, stop listening for commands and resume when the take ends. Leave off to keep barge-in (saying “stop” / “keep that” mid-take).",
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
  ...interactionSettings(),
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
    tool_range: "Range tool",
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
