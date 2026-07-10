type TestPointerEventInit = MouseEventInit & {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
  width?: number;
  height?: number;
  pressure?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
};

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly width: number;
  readonly height: number;
  readonly pressure: number;
  readonly tangentialPressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly altitudeAngle: number;
  readonly azimuthAngle: number;

  constructor(type: string, init: TestPointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
    this.width = init.width ?? 1;
    this.height = init.height ?? 1;
    this.pressure = init.pressure ?? 0;
    this.tangentialPressure = init.tangentialPressure ?? 0;
    this.tiltX = init.tiltX ?? 0;
    this.tiltY = init.tiltY ?? 0;
    this.twist = init.twist ?? 0;
    this.altitudeAngle = init.altitudeAngle ?? 0;
    this.azimuthAngle = init.azimuthAngle ?? 0;
  }

  getCoalescedEvents(): PointerEvent[] {
    return [];
  }

  getPredictedEvents(): PointerEvent[] {
    return [];
  }
}

if (typeof globalThis.PointerEvent === "undefined") {
  Object.defineProperty(globalThis, "PointerEvent", {
    value: TestPointerEvent,
    configurable: true,
    writable: true,
  });
}
