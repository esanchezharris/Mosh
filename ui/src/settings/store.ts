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
import { applySettingEffects } from "./effects";

export const STORAGE_KEY = "mosh.settings";
const LEGACY_VOICE_KEY = "mosh.voiceOn"; // pre-schema voice-mute flag ("0"/"1")
const VERSION = 1;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface Persisted {
  template: string | null;
  values: Record<string, SettingValue>;
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
    }>;
    const values: Record<string, SettingValue> = {};
    for (const [id, v] of Object.entries(parsed.values ?? {}))
      if (settingDef(id)) values[id] = coerceSetting(id, v as SettingValue);
    return { template: typeof parsed.template === "string" ? parsed.template : null, values };
  } catch {
    return { template: null, values: {} };
  }
}

// One-time migration from the pre-schema `mosh.voiceOn` flag, so an existing user's
// mute preference survives the fold-in. Only consulted when no unified settings exist.
function migrateLegacy(storage: Pick<Storage, "getItem">): Persisted {
  try {
    const legacy = storage.getItem(LEGACY_VOICE_KEY);
    if (legacy === "0") return { template: null, values: { voiceOn: false } };
  } catch {
    /* noop */
  }
  return { template: null, values: {} };
}

export function savePersisted(storage: Pick<Storage, "setItem">, state: Persisted): void {
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: VERSION, template: state.template, values: state.values }),
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

    get: (id) => {
      const v = get().values[id];
      return v !== undefined ? v : (settingDef(id)?.default as SettingValue);
    },

    set: (id, value) => {
      if (!settingDef(id)) return;
      const values = { ...get().values, [id]: coerceSetting(id, value) };
      set({ values });
      persist({ template: get().template, values });
    },

    applyTemplate: (name) => {
      const values = { ...get().values, ...templateValues(name) };
      set({ template: name, values });
      persist({ template: name, values });
    },

    // Back to schema defaults (no template, no overrides) + re-apply effects. Used
    // by tests and any "restore defaults" affordance.
    reset: () => {
      set({ template: null, values: {} });
      applySettingEffects(effectiveAll({}));
    },

    // Load from localStorage and project onto the document. Call once on boot,
    // BEFORE first render, so skin/theme/scale paint correctly with no flash.
    hydrate: () => {
      const s = storage();
      const next = s ? loadPersisted(s) : { template: null, values: {} };
      set(next);
      applySettingEffects(effectiveAll(next.values));
    },
  };
});
