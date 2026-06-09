// Type declarations for the vendored JUCE 8 frontend JS
// (juce_gui_extra/native/javascript/index.js, pinned with JUCE 7c89e11f).
// Runtime is the sibling index.js; these are types only.

export type EventListenerId = [string, number];

export function getNativeFunction(
  name: string
): (...args: unknown[]) => Promise<unknown>;

export function getBackendResourceAddress(path: string): string;

export class ControlParameterIndexUpdater {
  constructor(controlParameterIndexAnnotation: string);
  handleMouseMove(event: MouseEvent): void;
}

// Slider/toggle/comboBox state helpers exist too but are unused by Mosh's seam.
export function getSliderState(name: string): unknown;
export function getToggleState(name: string): unknown;
export function getComboBoxState(name: string): unknown;
