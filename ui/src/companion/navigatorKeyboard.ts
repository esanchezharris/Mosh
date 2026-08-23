import type { ControllerView } from "./adapter";
import * as nav from "./navMath";

export interface NavigatorKeyboardOptions {
  current(): ControllerView | null;
  seek(fraction: number): void;
}

export class NavigatorKeyboardController {
  readonly #bar: HTMLElement;
  readonly #options: NavigatorKeyboardOptions;

  constructor(bar: HTMLElement, options: NavigatorKeyboardOptions) {
    this.#bar = bar;
    this.#options = options;
  }

  attach(): void {
    this.#bar.addEventListener("keydown", (event) => this.#keydown(event));
  }

  #keydown(event: KeyboardEvent): void {
    const current = this.#options.current();
    if (current === null || !current.seekEnabled) return;
    let position: number;
    switch (event.key) {
      case "ArrowLeft":
        position = current.position - 1;
        break;
      case "ArrowRight":
        position = current.position + 1;
        break;
      case "Home":
        position = 0;
        break;
      case "End":
        position = current.length;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#options.seek(nav.clamp01(position / current.length));
  }
}
