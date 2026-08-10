import { useLayoutEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { pushEscapeHandler } from "../hooks/escapeStack";

type Props = {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
  readonly onCut: () => boolean;
  readonly onCopy: () => boolean;
  readonly onPaste: () => boolean;
  readonly onClose: () => void;
};

export function ProToolsAutomationMenu(props: Props) {
  const { x, y, label, canCopy, canPaste, onCut, onCopy, onPaste, onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus();
  }, []);

  useLayoutEffect(() => {
    const disposeEscape = pushEscapeHandler(onClose);
    const onOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const timer = window.setTimeout(() => window.addEventListener("pointerdown", onOutside), 0);
    return () => {
      disposeEscape();
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onOutside);
    };
  }, [onClose]);

  const enabledItems = () => [...(menuRef.current
    ?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      next = (current + 1) % items.length;
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      next = (current - 1 + items.length) % items.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  };

  const pick = (action: () => boolean) => {
    action();
    onClose();
  };

  return createPortal(
    <div ref={menuRef} className="pt-menu pt-automation-menu" role="menu" tabIndex={-1}
      aria-label={`${label} automation edit actions`} data-testid="pt-automation-menu"
      style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}>
      <button type="button" role="menuitem" tabIndex={-1} disabled={!canCopy}
        data-testid="pt-automation-cut" onClick={() => pick(onCut)}>
        <span>Cut</span><kbd>⌘X</kbd>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} disabled={!canCopy}
        data-testid="pt-automation-copy" onClick={() => pick(onCopy)}>
        <span>Copy</span><kbd>⌘C</kbd>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} disabled={!canPaste}
        data-testid="pt-automation-paste" onClick={() => pick(onPaste)}>
        <span>Paste</span><kbd>⌘V</kbd>
      </button>
    </div>,
    document.body,
  );
}
