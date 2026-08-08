// Which settings descriptors each shell hides. Classic shows everything. The v2
// shell is one Mosh-native design with no skin/keymap/gesture/layout axis (inert
// there, confusing). The live clone keeps every LIVE-effective axis — audio,
// routing, keys, feel, layout, templates all apply under it — and hides only the
// classic visual `skin` descriptor, which restyles classic/v2 chrome but never
// the fixed live-clone look (inert in this shell).

import type { ShellId } from "../v2/shellFlag";

const V2_HIDDEN_CATEGORIES = new Set(["Layout", "Interaction", "Feel", "Keys"]);

/** True when `id` (in `category`) should be hidden from Settings under `shell`. */
export function settingHiddenForShell(shell: ShellId, category: string, id: string): boolean {
  if (shell === "v2") return V2_HIDDEN_CATEGORIES.has(category) || id === "skin";
  if (shell === "live") return id === "skin";
  return false;
}
