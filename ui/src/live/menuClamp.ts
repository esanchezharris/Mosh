// Context menus open at the pointer, which can be anywhere — including near the
// window's bottom/right edge. Both live menus (clip / track header) call this on
// mount so a deep menu (the 70-swatch Colors grid is ~300pt tall) never lands
// partially off-screen.

export function clampMenuIntoViewport(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 8)
    el.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
  if (r.bottom > window.innerHeight - 8)
    el.style.top = `${Math.max(8, window.innerHeight - 8 - r.height)}px`;
}
