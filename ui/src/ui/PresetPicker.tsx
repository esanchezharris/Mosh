import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Plugin } from "../types";

// P1 preset seam — the mouse path onto list_presets / load_preset (the same seam the agent
// uses). Shared by the classic/v2 Rack and the V3 inspector + browser (V3 parity brief row 7).
// Shown only on instruments with a loadable preset format today: the built-in 4OSC ('4osc'
// bank, .json patches) and a hosted Vital ('vital', .vital patches). Other instruments (e.g.
// Serum) have no loadable format yet, so no picker rather than a picker that can't work.
// Selecting an option fires load_preset (one undo step) and resets the select so the same
// preset can be re-applied.

/** The preset bank key for a plugin, or null when it has no loadable preset format. */
export function presetKeyFor(plugin: Pick<Plugin, "builtin" | "type" | "name">): "4osc" | "vital" | null {
  if (plugin.builtin) return plugin.type === "4osc" ? "4osc" : null;
  return /vital/i.test(plugin.name) ? "vital" : null;
}

export function PresetPicker({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const exec = useStore((s) => s.exec);
  const [presets, setPresets] = useState<{ name: string; file: string }[] | null>(null);
  const key = presetKeyFor(plugin);
  useEffect(() => {
    if (!key) return;
    let dead = false;
    void exec("list_presets", { plugin: key }).then((r) => {
      if (dead || !r.ok) return;
      setPresets((r.data as { presets?: { name: string; file: string }[] } | undefined)?.presets ?? []);
    });
    return () => { dead = true; };
  }, [exec, key]);
  if (!key || !presets || presets.length === 0) return null;
  return (
    <select className="preset-pick" data-testid="preset-pick" value=""
      title="Load a preset" aria-label={`Load a preset onto ${plugin.name}`}
      onChange={(e) => {
        const file = e.target.value;
        if (file) void exec("load_preset", { trackId, index: plugin.index, file });
      }}>
      <option value="" disabled>Presets…</option>
      {presets.map((p) => <option key={p.file} value={p.file}>{p.name}</option>)}
    </select>
  );
}
