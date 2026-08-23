export interface NavigatorDragOptions {
  enabled(): boolean;
  seek(fraction: number, final: boolean): void;
  cancel(): void;
}

export class NavigatorDragController {
  readonly #bar: HTMLElement;
  readonly #options: NavigatorDragOptions;
  #pointerId: number | null = null;
  #fraction: number | null = null;

  constructor(bar: HTMLElement, options: NavigatorDragOptions) {
    this.#bar = bar;
    this.#options = options;
  }

  attach(): void {
    this.#bar.addEventListener("pointerdown", (event) => this.#start(event));
    this.#bar.addEventListener("pointermove", (event) => this.#move(event, false));
    this.#bar.addEventListener("pointerup", (event) => this.#finish(event));
    this.#bar.addEventListener("pointercancel", (event) => this.#cancel(event, true));
    this.#bar.addEventListener("lostpointercapture", (event) => this.#cancel(event, false));
  }

  placePlayhead(playhead: HTMLElement, fallbackFraction: number): void {
    playhead.style.left = `${(this.#fraction ?? fallbackFraction) * 100}%`;
  }

  #start(event: PointerEvent): void {
    if (!this.#options.enabled() || this.#pointerId !== null) return;
    this.#pointerId = event.pointerId;
    try {
      this.#bar.setPointerCapture(event.pointerId);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
    this.#move(event, false);
  }

  #move(event: PointerEvent, final: boolean): void {
    if (event.pointerId !== this.#pointerId) return;
    const rect = this.#bar.getBoundingClientRect();
    const fraction = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
    this.#fraction = fraction;
    const playhead = this.#bar.querySelector<HTMLElement>("#playhead");
    if (playhead !== null) this.placePlayhead(playhead, fraction);
    this.#options.seek(fraction, final);
  }

  #finish(event: PointerEvent): void {
    if (event.pointerId !== this.#pointerId) return;
    this.#move(event, true);
    this.#clear(event.pointerId, true);
  }

  #cancel(event: PointerEvent, releaseCapture: boolean): void {
    if (event.pointerId !== this.#pointerId) return;
    this.#options.cancel();
    this.#clear(event.pointerId, releaseCapture);
  }

  #clear(pointerId: number, releaseCapture: boolean): void {
    this.#pointerId = null;
    this.#fraction = null;
    if (!releaseCapture || !this.#bar.hasPointerCapture(pointerId)) return;
    try {
      this.#bar.releasePointerCapture(pointerId);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
  }
}
