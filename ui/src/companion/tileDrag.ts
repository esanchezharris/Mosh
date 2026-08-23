import { moveInOrder, TILES } from "./layout";
import type { Button } from "./types";

export interface EditableTileLayout {
  isEditing(): boolean;
  enterEditing(): void;
  order(): readonly Button[];
  setOrder(order: Button[]): void;
  applyOrder(): void;
  save(): void;
}

function tileAtPoint(x: number, y: number, current: HTMLElement): Button | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (!(element instanceof HTMLElement) || element === current) continue;
    const button = TILES.find((candidate) => candidate === element.dataset.id);
    if (button !== undefined) return button;
  }
  return null;
}

export class TileDragController {
  readonly #layout: EditableTileLayout;

  constructor(layout: EditableTileLayout) {
    this.#layout = layout;
  }

  attach(tile: HTMLButtonElement, button: Button): void {
    tile.addEventListener("pointerdown", (event) => this.#pointerDown(tile, button, event));
  }

  #pointerDown(tile: HTMLButtonElement, button: Button, event: PointerEvent): void {
    if (!this.#layout.isEditing()) {
      const timer = window.setTimeout(() => this.#layout.enterEditing(), 500);
      const clear = (): void => window.clearTimeout(timer);
      tile.addEventListener("pointerup", clear, { once: true });
      tile.addEventListener("pointermove", clear, { once: true });
      return;
    }

    event.preventDefault();
    try {
      tile.setPointerCapture(event.pointerId);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
    const rect = tile.getBoundingClientRect();
    const grab = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    tile.classList.add("dragging");
    Object.assign(tile.style, {
      position: "fixed",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      zIndex: "20",
    });

    const move = (next: PointerEvent): void => {
      tile.style.left = `${next.clientX - grab.x}px`;
      tile.style.top = `${next.clientY - grab.y}px`;
      const target = tileAtPoint(next.clientX, next.clientY, tile);
      if (target === null) return;
      const order = this.#layout.order();
      const index = order.indexOf(target);
      if (index >= 0 && index !== order.indexOf(button)) {
        this.#layout.setOrder(moveInOrder([...order], button, index));
        this.#layout.applyOrder();
      }
    };

    const finish = (): void => {
      tile.removeEventListener("pointermove", move);
      tile.classList.remove("dragging");
      Object.assign(tile.style, { position: "", width: "", height: "", left: "", top: "", zIndex: "" });
      this.#layout.applyOrder();
      this.#layout.save();
    };

    tile.addEventListener("pointermove", move);
    tile.addEventListener("pointerup", finish, { once: true });
    tile.addEventListener("pointercancel", finish, { once: true });
  }
}
