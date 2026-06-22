// Timeline annotations (redesign shell): a thin strip on the ruler carrying authored
// comment pins ("fix this transition"). Beat-anchored so they hold their musical spot
// across tempo edits. Double-click the strip to drop a note at that beat; click a pin to
// read it (with its author) and edit/delete. All mutation is via the command seam
// (create/edit/move/remove_annotation), which the backend broadcasts to collaborators —
// the author tag is the local session name. Lives ON the ruler (no extra row) so the
// track-header/lane vertical alignment is untouched.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Annotation } from "../types";

export function AnnotationRuler({
  annotations,
  beatToPx,
  pxToBeat,
}: {
  annotations: Annotation[];
  beatToPx: (beat: number) => number;
  pxToBeat: (px: number) => number;
}) {
  const exec = useStore((s) => s.exec);
  const mpActive = useStore((s) => s.mp.active);
  const selfPeer = useStore((s) => s.mp.selfPeer);
  const peers = useStore((s) => s.peers);
  const selfName = (mpActive && selfPeer && peers[selfPeer]?.name) || "you";
  const [openId, setOpenId] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Dismiss the open popover on outside-click / Escape — matches the app's popover
  // convention (ClipMenu, Pop, FileOptions). Deferred so the opening click doesn't
  // immediately close it.
  useEffect(() => {
    if (!openId) return;
    const onDoc = (e: PointerEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenId(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenId(null); };
    const t = window.setTimeout(() => { document.addEventListener("pointerdown", onDoc); document.addEventListener("keydown", onKey); }, 0);
    return () => { clearTimeout(t); document.removeEventListener("pointerdown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [openId]);

  const addAt = (clientX: number) => {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect) return;
    const beat = Math.max(0, Math.round(pxToBeat(clientX - rect.left)));
    const text = window.prompt("New note:");
    if (text && text.trim()) void exec("create_annotation", { text: text.trim(), beat, author: selfName });
  };
  const editPin = (a: Annotation) => {
    const text = window.prompt("Edit note (empty to delete):", a.text);
    if (text == null) return;
    if (text.trim()) void exec("edit_annotation", { annotationId: a.id, text: text.trim() });
    else void exec("remove_annotation", { annotationId: a.id });
  };
  const remove = (a: Annotation) => void exec("remove_annotation", { annotationId: a.id });

  return (
    <div
      ref={stripRef}
      className="annotation-ruler"
      data-testid="annotation-ruler"
      title="Double-click to drop a note"
      // Bare-strip pointer events bubble to the ruler (so seek/loop still work across the
      // full ruler height); only PINS swallow their pointer (below) so a pin-click reads
      // the note instead of seeking. Double-click the bare strip to drop a note.
      onDoubleClick={(e) => addAt(e.clientX)}
    >
      {annotations.map((a) => (
        <div key={a.id} className="annotation-pin" data-testid="annotation-pin" style={{ left: beatToPx(a.beat) }}>
          <button
            className="annotation-flag"
            style={{ background: a.color ?? "var(--lime-dim)" }}
            title={`${a.text}${a.author ? " — " + a.author : ""}`}
            aria-label={`Annotation: ${a.text}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setOpenId((cur) => (cur === a.id ? null : a.id))}
          >
            <span aria-hidden="true">📍</span>
          </button>
          {openId === a.id && (
            <div className="annotation-pop" role="dialog" aria-label="Annotation" ref={popRef}>
              <div className="annotation-text">{a.text}</div>
              {a.author && <div className="annotation-author tc">— {a.author}</div>}
              <div className="annotation-actions">
                <button className="btn" onClick={() => { editPin(a); setOpenId(null); }}>Edit</button>
                <button className="btn" onClick={() => { remove(a); setOpenId(null); }}>Delete</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
