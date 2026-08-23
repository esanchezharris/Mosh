import type { Button } from "./types";

const BUTTON_META: Readonly<Record<Button, { readonly label: string; readonly sub: string; readonly className: string }>> = {
  record: { label: "PUT ME IN", sub: "record at cursor", className: "rec" },
  keep: { label: "KEEP", sub: "stash · roll again", className: "keep" },
  again: { label: "AGAIN", sub: "redo the take", className: "again" },
  hear: { label: "HEAR IT", sub: "play back", className: "hear" },
  marker: { label: "MARKER", sub: "flag this moment", className: "marker" },
  stop: { label: "STOP", sub: "", className: "stop" },
};

export function buttonLabel(button: Button): string {
  return BUTTON_META[button].label;
}

export function mountPadTiles(
  grid: HTMLElement,
  buttons: readonly Button[],
  onPress: (button: Button) => void,
): readonly HTMLButtonElement[] {
  grid.replaceChildren();
  return buttons.map((button) => {
    const meta = BUTTON_META[button];
    const tile = document.createElement("button");
    tile.className = `tile ${meta.className}`;
    tile.dataset.id = button;
    const label = document.createElement("span");
    label.className = "lbl";
    label.textContent = meta.label;
    tile.append(label);
    if (meta.sub.length > 0) {
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = meta.sub;
      tile.append(sub);
    }
    tile.addEventListener("click", () => onPress(button));
    grid.append(tile);
    return tile;
  });
}
