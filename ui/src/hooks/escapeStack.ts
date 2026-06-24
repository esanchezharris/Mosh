// Shared Escape stack (AL-001).
//
// Every overlay used to register its OWN window-level keydown listener, so a
// single Escape press fired all of them and closed every open overlay at once.
// This module keeps ONE window listener and a LIFO stack of close handlers:
// Escape routes only to the topmost (last-pushed) overlay, leaving the ones
// beneath it open. Closing the top overlay tears down its handler and the next
// Escape falls through to the new top.

type CloseHandler = () => void;

const stack: CloseHandler[] = [];
let listening = false;

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  // Capture phase already ran; stop other window-level keydown handlers (e.g.
  // the arrangement's global shortcuts) from also acting on this Escape.
  e.stopPropagation();
  top();
}

function ensureListening(): void {
  if (listening) return;
  // Capture phase so the stack decides the Escape before bubble-phase handlers
  // (and before stopPropagation would matter to them).
  window.addEventListener("keydown", onKey, true);
  listening = true;
}

function stopListeningIfEmpty(): void {
  if (stack.length > 0 || !listening) return;
  window.removeEventListener("keydown", onKey, true);
  listening = false;
}

/**
 * Push a close handler onto the Escape stack. The returned disposer removes it.
 * Only the most-recently-pushed (topmost) handler receives Escape.
 */
export function pushEscapeHandler(close: CloseHandler): () => void {
  stack.push(close);
  ensureListening();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = stack.lastIndexOf(close);
    if (i !== -1) stack.splice(i, 1);
    stopListeningIfEmpty();
  };
}

/** Current depth of the Escape stack (test/diagnostic helper). */
export function escapeStackDepth(): number {
  return stack.length;
}
