// AGT-MEM (M3) — the "remember that…" fastPath rule's confirm toast. Mirrors
// ChangeToast.tsx's shape/timing (same .v2-toast classes — no new CSS) with one
// deliberate difference: a memory write is non-undoable BY DESIGN (M1), so this
// toast's Undo calls agent_memory_delete on the just-written item's `ts`, never the
// real undo command.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { executeCommand } from "../bridge";
import type { CommandResult } from "../types";
import { invalidateMemoryHydration } from "../agent/memory/hydrate";

const HOLD_MS = 4500;
const RESUME_MS = 2000;
const FADE_MS = 260;

export function MemoryToast() {
  const toast = useStore((s) => s.memoryToast);
  const setToast = useStore((s) => s.setMemoryToast);
  const [leaving, setLeaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const timer = useRef(0);

  const dismiss = () => { setLeaving(true); window.setTimeout(() => setToast(null), FADE_MS); };
  const arm = (ms: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(dismiss, ms); };

  useEffect(() => {
    if (!toast) { setLeaving(false); setUndoing(false); return; }
    setLeaving(false);
    arm(HOLD_MS);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  if (!toast) return null;

  const undo = async () => {
    window.clearTimeout(timer.current);
    setUndoing(true);
    const res = await executeCommand<CommandResult>({
      command: "agent_memory_delete",
      args: { scope: toast.scope, kind: toast.kind, ts: toast.ts },
    });
    if (res.ok) invalidateMemoryHydration();
    setToast(null);
  };

  return (
    <div
      className={`v2-toast${leaving ? " out" : ""}`}
      role="status" aria-live="polite" data-testid="v2-memory-toast"
      onMouseEnter={() => window.clearTimeout(timer.current)}
      onMouseLeave={() => arm(RESUME_MS)}
    >
      <span className="v2-toast-dot" aria-hidden>✦</span>
      <span className="v2-toast-text">
        Remembered{toast.scope === "project" ? " for this project" : ""}: {toast.text}
      </span>
      <button
        className="v2-toast-undo" data-testid="v2-memory-toast-undo"
        disabled={undoing} onClick={() => void undo()}
      >
        Undo
      </button>
    </div>
  );
}
