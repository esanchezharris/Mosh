import { useEffect, useRef, type RefObject } from "react";
import { useTaskStore } from "../agent/loop/taskStore";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { AgentComposer } from "../ui/AgentComposer";
import { AgentDrawer } from "../v2/agent/AgentDrawer";
import { ChangeToast } from "../v2/ChangeToast";

export function ProToolsMoshiDrawer({ open, onClose, returnFocusRef }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement>;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const hasTask = useTaskStore((state) => state.current !== null || state.last !== null);
  const setTaskDrawerOpen = useTaskStore((state) => state.setDrawerOpen);

  useEffect(() => {
    if (!open) return undefined;
    return pushEscapeHandler(onClose);
  }, [onClose, open]);
  useEffect(() => {
    if (!open) return undefined;
    const returnFocus = returnFocusRef.current;
    if (hasTask) setTaskDrawerOpen(true);
    drawerRef.current?.querySelector<HTMLInputElement>("[data-testid=agent-input]")?.focus();
    return () => returnFocus?.focus();
  }, [hasTask, open, returnFocusRef, setTaskDrawerOpen]);

  if (!open) return null;
  return (
    <aside ref={drawerRef} id="pt-moshi-drawer" className="pt-moshi-drawer" data-testid="pt-moshi-drawer"
      role="complementary" aria-label="Ask Moshi">
      <header className="pt-moshi-head">
        <div><strong>Ask Moshi</strong><span>Optional session assistant</span></div>
        <button type="button" data-testid="pt-moshi-close" onClick={onClose}>Close</button>
      </header>
      <div className="pt-moshi-body">
        <AgentDrawer />
        <ChangeToast />
        <AgentComposer />
      </div>
    </aside>
  );
}
