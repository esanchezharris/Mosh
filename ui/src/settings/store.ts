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
import {
  DEFAULT_WORKFLOW_PROFILE_ID,
  getWorkflowProfile,
  isWorkflowBrowserTab,
  isWorkflowSectionZoom,
  type WorkflowProfileId,
  type WorkflowWorkspace,
  type WorkflowWorkspaceOverride,
} from "./workflowProfiles";

export const STORAGE_KEY = "mosh.settings";
const LEGACY_VOICE_KEY = "mosh.voiceOn"; // pre-schema voice-mute flag ("0"/"1")
const VERSION = 3;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

// Per-keymap keybind rebinds (AL-002). `key.<action>` overrides are scoped to the active
// keymap (mosh/ableton/fl/…) instead of living globally in `values`, so a rebind made
// under one DAW keymap doesn't bleed into another. Shape: { keymapName: { "key.undo": "Mod+P" } }.
export type KeyOverrides = Record<string, Record<string, string>>;

export type WorkspaceByProfile = Partial<Record<WorkflowProfileId, WorkflowWorkspaceOverride>>;

export interface Persisted {
  template: string | null;
  values: Record<string, SettingValue>;
  keyOverrides: KeyOverrides;
  workspaceByProfile: WorkspaceByProfile;
  workflowOnboardingDismissed: boolean;
}

export type PersistedInput = Omit<Persisted, "workspaceByProfile" | "workflowOnboardingDismissed">
  & Partial<Pick<Persisted, "workspaceByProfile" | "workflowOnboardingDismissed">>;

// True for the rebindable `key.<action>` setting ids (the per-keymap-scoped ones).
function isKeyId(id: string): boolean {
  return id.startsWith("key.");
}

// The active keymap that scopes key.* rebinds: the effective `keymap` value
// (override ?? schema default), always defined even with no named template.
function activeKeymap(values: Record<string, SettingValue>): string {
  const v = values.keymap;
  if (typeof v === "string") return v;
  const d = settingDef("keymap")?.default;
  return typeof d === "string" ? d : "mosh";
}

function activeKeyScope(values: Record<string, SettingValue>): string {
  if (values.uiShell === "classic") return activeKeymap(values);
  return getWorkflowProfile(values.workflowProfile).id;
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

function sanitizeWorkspaceOverride(raw: unknown): WorkflowWorkspaceOverride {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const out: WorkflowWorkspaceOverride = {};
  if (typeof input.browserOpen === "boolean") out.browserOpen = input.browserOpen;
  if (isWorkflowBrowserTab(input.browserTab)) out.browserTab = input.browserTab;
  if (typeof input.rightOpen === "boolean") out.rightOpen = input.rightOpen;
  if (isWorkflowSectionZoom(input.sectionZoom)) out.sectionZoom = input.sectionZoom;
  if (typeof input.drumWindowOpen === "boolean") out.drumWindowOpen = input.drumWindowOpen;
  return out;
}

function sanitizeWorkspaceMap(raw: unknown): WorkspaceByProfile {
  const out: WorkspaceByProfile = {};
  if (!raw || typeof raw !== "object") return out;
  for (const profileId of ["mosh", "fl"] as const) {
    const override = sanitizeWorkspaceOverride((raw as Record<string, unknown>)[profileId]);
    if (Object.keys(override).length) out[profileId] = override;
  }
  return out;
}

function emptyPersisted(workflowOnboardingDismissed: boolean): Persisted {
  return {
    template: null,
    values: {},
    keyOverrides: {},
    workspaceByProfile: {},
    workflowOnboardingDismissed,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Read + sanitise persisted state. Unknown ids are dropped; every surviving value is
// coerced against the schema. A parse failure degrades to empty (→ all defaults).
export function loadPersisted(storage: Pick<Storage, "getItem">): Persisted {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return emptyPersisted(true);
  }

  if (raw === null) return migrateLegacy(storage);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return emptyPersisted(true);
    const rawValues = parsed.values;
    if (rawValues !== undefined && !isObject(rawValues)) return emptyPersisted(true);
    const values: Record<string, SettingValue> = {};
    for (const [id, v] of Object.entries((rawValues ?? {}) as Record<string, unknown>))
      if (settingDef(id)) values[id] = coerceSetting(id, v as SettingValue);

    const version = typeof parsed.version === "number" ? parsed.version : 1;
    if (version > VERSION) return emptyPersisted(true);
    const isV3 = version === VERSION;
    const workflowProfile = isV3
      ? getWorkflowProfile(values.workflowProfile).id
      : DEFAULT_WORKFLOW_PROFILE_ID;
    values.workflowProfile = workflowProfile;

    const rawWorkspace = parsed.workspaceByProfile ?? parsed.workspace;
    return {
      template: typeof parsed.template === "string" ? parsed.template : null,
      values,
      keyOverrides: sanitizeKeyOverrides(parsed.keyOverrides),
      workspaceByProfile: sanitizeWorkspaceMap(rawWorkspace),
      workflowOnboardingDismissed: isV3 && typeof parsed.workflowOnboardingDismissed === "boolean"
        ? parsed.workflowOnboardingDismissed
        : true,
    };
  } catch {
    return emptyPersisted(true);
  }
}

// One-time migration from the pre-schema `mosh.voiceOn` flag, so an existing user's
// mute preference survives the fold-in. Only consulted when no unified settings exist.
function migrateLegacy(storage: Pick<Storage, "getItem">): Persisted {
  try {
    const legacy = storage.getItem(LEGACY_VOICE_KEY);
    if (legacy !== null) {
      return {
        template: null,
        values: { ...(legacy === "0" ? { voiceOn: false } : {}), workflowProfile: DEFAULT_WORKFLOW_PROFILE_ID },
        keyOverrides: {},
        workspaceByProfile: {},
        workflowOnboardingDismissed: true,
      };
    }
  } catch {
    /* noop */
  }
  return emptyPersisted(false);
}

export function savePersisted(storage: Pick<Storage, "setItem">, state: PersistedInput): void {
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: VERSION,
        template: state.template,
        values: state.values,
        keyOverrides: state.keyOverrides,
        workspaceByProfile: state.workspaceByProfile ?? {},
        workflowOnboardingDismissed: state.workflowOnboardingDismissed ?? true,
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
  workspaceByProfile: WorkspaceByProfile;
  workflowOnboardingDismissed: boolean;
  get: (id: string) => SettingValue;
  set: (id: string, value: SettingValue) => void;
  applyTemplate: (name: string) => void;
  setWorkflowProfile: (id: string) => void;
  saveWorkspaceOverride: (profileId: string, override: WorkflowWorkspaceOverride) => void;
  getEffectiveWorkspace: (profileId?: string) => WorkflowWorkspace;
  dismissWorkflowOnboarding: () => void;
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
    workspaceByProfile: {},
    workflowOnboardingDismissed: false,

    get: (id) => {
      const state = get();
      if (isKeyId(id)) {
        // Per-keymap rebind wins; fall back to a legacy global override (v1 blobs), then
        // the schema default ("" = inherit the preset).
        const scoped = state.keyOverrides[activeKeyScope(state.values)]?.[id];
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
        const km = activeKeyScope(get().values);
        const keyOverrides: KeyOverrides = { ...get().keyOverrides };
        const bucket = { ...(keyOverrides[km] ?? {}) };
        const combo = coerceSetting(id, value) as string;
        if (combo === "") delete bucket[id];
        else bucket[id] = combo;
        if (Object.keys(bucket).length) keyOverrides[km] = bucket;
        else delete keyOverrides[km];
        set({ keyOverrides });
        persist({
          template: get().template,
          values: get().values,
          keyOverrides,
          workspaceByProfile: get().workspaceByProfile,
          workflowOnboardingDismissed: get().workflowOnboardingDismissed,
        });
        return;
      }
      const values = { ...get().values, [id]: coerceSetting(id, value) };
      set({ values });
      persist({
        template: get().template,
        values,
        keyOverrides: get().keyOverrides,
        workspaceByProfile: get().workspaceByProfile,
        workflowOnboardingDismissed: get().workflowOnboardingDismissed,
      });
    },

    applyTemplate: (name) => {
      const values = { ...get().values, ...templateValues(name) };
      set({ template: name, values });
      persist({
        template: name,
        values,
        keyOverrides: get().keyOverrides,
        workspaceByProfile: get().workspaceByProfile,
        workflowOnboardingDismissed: get().workflowOnboardingDismissed,
      });
    },

    setWorkflowProfile: (id) => {
      const values = { ...get().values, workflowProfile: getWorkflowProfile(id).id };
      set({ values });
      persist({
        template: get().template,
        values,
        keyOverrides: get().keyOverrides,
        workspaceByProfile: get().workspaceByProfile,
        workflowOnboardingDismissed: get().workflowOnboardingDismissed,
      });
    },

    saveWorkspaceOverride: (profileId, override) => {
      const id = getWorkflowProfile(profileId).id;
      const clean = sanitizeWorkspaceOverride(override);
      const workspaceByProfile: WorkspaceByProfile = { ...get().workspaceByProfile };
      const merged = { ...(workspaceByProfile[id] ?? {}), ...clean };
      if (Object.keys(merged).length) workspaceByProfile[id] = merged;
      else delete workspaceByProfile[id];
      set({ workspaceByProfile });
      persist({
        template: get().template,
        values: get().values,
        keyOverrides: get().keyOverrides,
        workspaceByProfile,
        workflowOnboardingDismissed: get().workflowOnboardingDismissed,
      });
    },

    getEffectiveWorkspace: (profileId) => {
      const id = getWorkflowProfile(profileId ?? get().get("workflowProfile")).id;
      return {
        ...getWorkflowProfile(id).workspaceDefaults,
        ...(get().workspaceByProfile[id] ?? {}),
      };
    },

    dismissWorkflowOnboarding: () => {
      set({ workflowOnboardingDismissed: true });
      persist({
        template: get().template,
        values: get().values,
        keyOverrides: get().keyOverrides,
        workspaceByProfile: get().workspaceByProfile,
        workflowOnboardingDismissed: true,
      });
    },

    // Back to schema defaults (no template, no overrides) — persisted, so a reload
    // doesn't resurrect cleared overrides. Used by the "Reset" affordance + tests.
    reset: () => {
      const next: Persisted = {
        template: null,
        values: {},
        keyOverrides: {},
        workspaceByProfile: {},
        workflowOnboardingDismissed: true,
      };
      set(next);
      persist(next);
    },

    // Load from localStorage and project onto the document. Call once on boot,
    // BEFORE first render, so skin/theme/scale paint correctly with no flash.
    hydrate: () => {
      const s = storage();
      const next = s ? loadPersisted(s) : emptyPersisted(false);
      set(next);
      applySettingEffects(effectiveAll(next.values));
    },
  };
});
