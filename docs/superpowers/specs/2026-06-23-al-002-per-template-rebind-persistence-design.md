# AL-002 — Per-template rebind persistence

## Problem

Keybind rebinds (`key.<action>` settings, e.g. `key.undo`) are stored as **global**
overrides in the settings store's flat `values` map. They are template-agnostic: there
is one `key.undo` value regardless of which DAW template/keymap is active.

Concretely, the gap:

- A user on the **Ableton** keymap rebinds Undo to `Mod+P`.
- They switch the keymap/template to **Mosh**.
- `applyTemplate("mosh")` does `{ ...values, ...templateValues("mosh") }`. Template
  bundles don't include any `key.*` ids, so the Ableton-era `key.undo = Mod+P` survives
  and now applies under Mosh too.

The rebind **bleeds across templates**. AL-002 wants rebinds scoped **per template**:
a rebind made while a given keymap is active applies only under that keymap, persists to
localStorage, and round-trips across reload. Switching keymap swaps in that keymap's own
rebind set.

## Scope axis

Keybinds are governed by the `keymap` setting (`buildKeymap` in
`ui/src/interaction/config.ts` reads `get("keymap")` for the base preset, then layers
`key.*` overrides). The natural, always-defined scoping axis is therefore the **effective
`keymap` value** (`mosh` | `ableton` | `fl` | `protools` | `logic`) — not the optional
named `template` (which can be `null`). Scoping by `keymap`:

- is well-defined even with no named template applied (defaults to `"mosh"`),
- matches the user's mental model ("rebinds for the Ableton keymap"),
- requires no change to `buildKeymap` / `SettingsPanel` (they keep calling
  `get`/`set` with the same `key.<action>` ids).

## Design

All changes are confined to `ui/src/settings/store.ts` (UI-local, no backend command,
swappable seam untouched). The schema, the rebind UI, and the keymap builder are unchanged.

### Data model

Add a persisted, per-keymap sub-map alongside the existing flat `values`:

```ts
keyOverrides: Record<string /* keymap name */, Record<string /* key.<action> id */, string>>
```

- `values` continues to hold all non-key overrides (skin, theme, feel.*, keymap, …).
- `key.*` overrides move into `keyOverrides[<active keymap>]`.

### Resolution (`get`)

For a `key.*` id, resolve in order:
1. `keyOverrides[<active keymap>][id]` — the per-keymap rebind,
2. `values[id]` — legacy/global key override (back-compat with already-persisted state),
3. schema default (`""` → inherit the preset).

The active keymap is the effective `keymap` value: `values.keymap ?? schema-default`.
All other ids keep the existing `values[id] ?? default` path.

### Write (`set`)

For a `key.*` id, write into `keyOverrides[<active keymap>][id]` (coerced). Setting it to
`""` (the clear-to-inherit affordance) **deletes** the entry so it doesn't shadow the
preset and the sub-map stays tidy. All other ids keep the existing flat-`values` write.

### Persistence

`Persisted` gains `keyOverrides`. `savePersisted` writes it; `loadPersisted` reads and
sanitises it (drop unknown keymap names and unknown/non-`key.` ids, coerce each value).
`reset` clears it. `migrateLegacy` returns it empty. Bump the storage `VERSION` to 2;
a v1 blob (which never had `keyOverrides`) simply hydrates with an empty map — its global
`key.*` entries in `values` still apply via the resolution fallback, so no user loses a
rebind.

### Why not scope by named `template`

`template` is `null` until a template is explicitly applied, so it can't scope a rebind
made in the default state. `keymap` is the real keyboard axis and is always defined.

## Testing (vitest, `ui/src/settings/store.test.ts`)

1. **Per-keymap isolation**: with `keymap=ableton`, `set("key.undo", "Mod+P")`; switch
   `keymap=mosh` → `get("key.undo")` is `""` (Mosh's own, untouched); switch back to
   `ableton` → `Mod+P` returns. (This is the core bleed-fix.)
2. **Round-trip across reload**: rebind under two different keymaps, simulate reload
   (`setState` blank → `hydrate`), assert each keymap's rebind comes back under that keymap.
3. **Clear-to-inherit**: `set("key.undo", "")` removes the per-keymap entry.
4. **Back-compat**: a v1 blob with a global `values["key.undo"]` still resolves via the
   fallback after hydrate.
5. **savePersisted/loadPersisted exact round-trip** including `keyOverrides`.

## Out of scope / unchanged

- No backend / MoshOps command (swappable seam).
- `buildKeymap`, `SettingsPanel`, schema, templates: untouched.
- Non-key settings keep the exact flat-override semantics.
