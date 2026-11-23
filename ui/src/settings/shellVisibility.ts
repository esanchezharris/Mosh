// Which settings descriptors the Settings surfaces hide. V3 is the only shell.

/** Settings with their own control elsewhere, hidden from every Settings surface. */
const HIDDEN_EVERYWHERE = new Set(["startOnLaunch"]);

/** True when `id` (in `category`) should be hidden from Settings. */
export function settingHidden(_category: string, id: string): boolean {
  return HIDDEN_EVERYWHERE.has(id);
}
