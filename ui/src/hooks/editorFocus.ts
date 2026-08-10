export function editorKeyFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && !!el.closest('[data-testid="piano-roll"]');
}
