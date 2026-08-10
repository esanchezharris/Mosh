const EDIT_SELECTION_BLOCKERS = [
  "[data-clip-id]",
  "button",
  "input",
  "select",
  "textarea",
  "[role=button]",
  ".pt-playlists",
  ".pt-automation-lane-frame",
].join(",");

export function proToolsLaneTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".pt-lane");
}

export function proToolsEditableLaneTarget(target: EventTarget | null): HTMLElement | null {
  const lane = proToolsLaneTarget(target);
  if (!lane || !(target instanceof Element) || target.closest(EDIT_SELECTION_BLOCKERS)) return null;
  return lane;
}
