// Templates = preset bundles of settings values over the schema.
//
// Selecting a template materialises all of its values into the store; the user can
// then override any individual setting on top (template + diffs). Templates are
// pure UI-local presets — like everything else here, they never touch the backend.
// A bundle is partial: it only names the ids it wants to pin (skin + dark/light
// today; later keymap + gestures + layout will join the same shape).

import { coerceSetting, settingDef, type SettingValue } from "./schema";

export interface Template {
  name: string;
  label: string;
  values: Record<string, SettingValue>;
}

export const TEMPLATES: Template[] = [
  {
    name: "mosh",
    label: "Mosh",
    values: { skin: "mosh", theme: "dark" },
  },
  {
    name: "ableton",
    label: "Ableton",
    values: { skin: "ableton", theme: "light" },
  },
  {
    name: "fl",
    label: "FL",
    values: { skin: "fl", theme: "dark" },
  },
];

const BY_NAME: Record<string, Template> = Object.fromEntries(
  TEMPLATES.map((t) => [t.name, t]),
);

export function template(name: string): Template | undefined {
  return BY_NAME[name];
}

// A coerced copy of a template's values, dropping any id not in the schema. This is
// what applyTemplate writes into the store, so a malformed template can never poison
// state — same defensive funnel the persistence layer uses.
export function templateValues(name: string): Record<string, SettingValue> {
  const t = template(name);
  if (!t) return {};
  const out: Record<string, SettingValue> = {};
  for (const [id, v] of Object.entries(t.values))
    if (settingDef(id)) out[id] = coerceSetting(id, v);
  return out;
}
