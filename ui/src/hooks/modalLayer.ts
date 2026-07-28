// Is this node inside a modal layer (a ConfirmDialog / .modal-backdrop) rather than in
// ordinary page content?
//
// Popovers dismiss themselves on an outside pointerdown. A modal opened FROM inside a
// popover is portaled to document.body (so it isn't trapped by the popover's own
// `backdrop-filter`, which makes the popover a containing block for `position: fixed`
// descendants), which means it is no longer a DOM descendant of the popover — so every
// click inside that modal reads as "outside" and tears down the popover that owns it,
// taking the modal with it.
//
// A modal is always stacked ABOVE the popover that opened it, so a click in it should
// never dismiss what's underneath. Escape ordering is handled separately and correctly by
// the shared LIFO escapeStack.
export function isInModalLayer(node: Node | null): boolean {
  if (!node) return false;
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest('.modal-backdrop, [role="dialog"], [role="alertdialog"]'));
}
