// The canonical settings store — schema-driven, localStorage-backed, UI-local.
//
// State model: `values` holds explicit OVERRIDES (whatever's been set, whether by a
// template application or a single tweak); the effective value of a setting is
// `values[id] ?? schema-default`. A template materialises its bundle into `values`
// and records its name in `template` (for the picker highlight); a per-setting `set`
// writes one override on top — that's the "template + diffs" model.
//
// Persistence is the override map + the template name, under a single versioned key.
// Everything funnels through coerceSetting so a corrupted/out-of-range persisted
// value can never poison state. NONE of this crosses the bridge — the backend has no
// knowledge of skins/themes/templates (swappable-seam rule).

import { create } from "zustand";
import {
  coerceSetting,
  defaultSettings,
  settingDef,
  type SettingValue,
} from "./schema";
import { templateValues } from "./templates";
import { resolveShell } from "../v2/shellQuery";
import { applySettingEffects } from "./effects";

export const STORAGE_KEY = "mosh.settings";
const LEGACY_VOICE_KEY = "mosh.voiceOn"; // pre-schema voice-mute flag ("0"/"1")
const VERSION = 2; // v1 had no keyOverrides; a v1 blob hydrates with an empty map

type StorageLike = Pick<Storage, "getItem" | "setItem">;

// Per-keymap keybind rebinds (AL-002). `key.<action>` overrides are scoped to the active
// keymap (mosh/ableton/fl/…) instead of living globally in `values`, so a rebind made
// under one DAW keymap doesn't bleed into another. Shape: { keymapName: { "key.undo": "Mod+P" } }.
type KeyOverrides = Record<string, Record<string, string>>;

interface Persisted {
  template: string | null;
  values: Record<string, SettingValue>;
  keyOverrides: KeyOverrides;
}

// True for the rebindable `key.<action>` setting ids (the per-keymap-scoped ones).
function isKeyId(id: string): boolean {
  return id.startsWith("key.");
}

// The active keymap that scopes key.* rebinds: the effective `keymap` value
// (override ?? schema default), always defined even with no named template.
// Mirrors effectiveInteractionSetting() in interaction/config.ts: under a DAW shell,
// an UNSET keymap resolves to that shell's native bundle so rebinds land in the same
// bucket that the effective keymap reads.
function activeKeymap(values: Record<string, SettingValue>): string {
  const v = values.keymap;
  if (typeof v === "string") return v;
  const shell = resolveShell(
    typeof values.uiShell === "string" ? values.uiShell : settingDef("uiShell")?.default,
  );
  switch (shell) {
    case "live": return "ableton";
    case "protools": return "protools";
    case "classic":
    case "v2":
    case "v3": break;
    default: {
      const unreachable: never = shell;
      return unreachable;
    }
  }
  const d = settingDef("keymap")?.default;
  return typeof d === "string" ? d : "mosh";
}

// Sanitise a persisted keyOverrides blob: keep only string keymap buckets, drop any
// non-`key.` id or non-string value, and coerce each surviving value. Empty buckets are
// dropped so the map stays tidy (matches the live clear-to-inherit behaviour).
function sanitizeKeyOverrides(raw: unknown): KeyOverrides {
  const out: KeyOverrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [keymap, bucket] of Object.entries(raw as Record<string, unknown>)) {
    if (!bucket || typeof bucket !== "object") continue;
    const clean: Record<string, string> = {};
    for (const [id, v] of Object.entries(bucket as Record<string, unknown>)) {
      if (isKeyId(id) && settingDef(id) && typeof v === "string" && v !== "")
        clean[id] = coerceSetting(id, v) as string;
    }
    if (Object.keys(clean).length) out[keymap] = clean;
  }
  return out;
}

// Read + sanitise persisted state. Unknown ids are dropped; every surviving value is
// coerced against the schema. A parse failure degrades to empty (→ all defaults).
export function loadPersisted(storage: Pick<Storage, "getItem">): Persisted {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return migrateLegacy(storage);
    const parsed = JSON.parse(raw) as Partial<{
      template: string;
      values: Record<string, SettingValue>;
      keyOverrides: unknown;
    }>;
    const values: Record<string, SettingValue> = {};
    for (const [id, v] of Object.entries(parsed.values ?? {}))
      if (settingDef(id)) values[id] = coerceSetting(id, v as SettingValue);
    return {
      template: typeof parsed.template === "string" ? parsed.template : null,
      values,
      keyOverrides: sanitizeKeyOverrides(parsed.keyOverrides),
    };
  } catch {
    return { template: null, values: {}, keyOverrides: {} };
  }
}

// One-time migration from the pre-schema `mosh.voiceOn` flag, so an existing user's
// mute preference survives the fold-in. Only consulted when no unified settings exist.
function migrateLegacy(storage: Pick<Storage, "getItem">): Persisted {
  try {
    const legacy = storage.getItem(LEGACY_VOICE_KEY);
    if (legacy === "0") return { template: null, values: { voiceOn: false }, keyOverrides: {} };
  } catch {
    /* noop */
  }
  return { template: null, values: {}, keyOverrides: {} };
}

export function savePersisted(storage: Pick<Storage, "setItem">, state: Persisted): void {
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: VERSION,
        template: state.template,
        values: state.values,
        keyOverrides: state.keyOverrides,
      }),
    );
  } catch {
    /* storage unavailable — settings simply don't persist this session */
  }
}

// The merged effective map (defaults under overrides) — what the effect applier
// projects onto the document.
function effectiveAll(values: Record<string, SettingValue>): Record<string, SettingValue> {
  return { ...defaultSettings(), ...values };
}

function storage(): StorageLike | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

interface SettingsState {
  template: string | null;
  values: Record<string, SettingValue>;
  keyOverrides: KeyOverrides;
  get: (id: string) => SettingValue;
  set: (id: string, value: SettingValue) => void;
  applyTemplate: (name: string) => void;
  reset: () => void;
  hydrate: () => void;
}

export const useSettings = create<SettingsState>((set, get) => {
  const persist = (next: Persisted) => {
    const s = storage();
    if (s) savePersisted(s, next);
    applySettingEffects(effectiveAll(next.values));
  };

  return {
    template: null,
    values: {},
    keyOverrides: {},

    get: (id) => {
      const state = get();
      if (isKeyId(id)) {
        // Per-keymap rebind wins; fall back to a legacy global override (v1 blobs), then
        // the schema default ("" = inherit the preset).
        const scoped = state.keyOverrides[activeKeymap(state.values)]?.[id];
        if (scoped !== undefined) return scoped;
      }
      const v = state.values[id];
      return v !== undefined ? v : (settingDef(id)?.default as SettingValue);
    },

    set: (id, value) => {
      if (!settingDef(id)) return;
      if (isKeyId(id)) {
        // Scope the rebind to the active keymap. Setting "" (the clear-to-inherit
        // affordance) DELETES the entry so it can't shadow the preset.
        const km = activeKeymap(get().values);
        const keyOverrides: KeyOverrides = { ...get().keyOverrides };
        const bucket = { ...(keyOverrides[km] ?? {}) };
        const combo = coerceSetting(id, value) as string;
        if (combo === "") delete bucket[id];
        else bucket[id] = combo;
        if (Object.keys(bucket).length) keyOverrides[km] = bucket;
        else delete keyOverrides[km];
        set({ keyOverrides });
        persist({ template: get().template, values: get().values, keyOverrides });
        return;
      }
      const values = { ...get().values, [id]: coerceSetting(id, value) };
      set({ values });
      persist({ template: get().template, values, keyOverrides: get().keyOverrides });
    },

    applyTemplate: (name) => {
      const values = { ...get().values, ...templateValues(name) };
      set({ template: name, values });
      persist({ template: name, values, keyOverrides: get().keyOverrides });
    },

    // Back to schema defaults (no template, no overrides) — persisted, so a reload
    // doesn't resurrect cleared overrides. Used by the "Reset" affordance + tests.
    reset: () => {
      const next: Persisted = { template: null, values: {}, keyOverrides: {} };
      set(next);
      persist(next);
    },

    // Load from localStorage and project onto the document. Call once on boot,
    // BEFORE first render, so skin/theme/scale paint correctly with no flash.
    hydrate: () => {
      const s = storage();
      const next = s ? loadPersisted(s) : { template: null, values: {}, keyOverrides: {} };
      set(next);
      applySettingEffects(effectiveAll(next.values));
    },
  };
});
