import { useEffect, useRef } from "react";
import { isRealNative, setEditorCursor, type EditorCursorKind } from "../bridge";

export type PianoRollCursor = "default" | "crosshair" | "grab" | "grabbing" | "ew-resize";

export const pianoRollCursorCss = (cursor: PianoRollCursor): string =>
  cursor === "ew-resize" && isRealNative() ? "col-resize" : cursor;

const NATIVE_CURSOR: Readonly<Record<PianoRollCursor, EditorCursorKind>> = Object.freeze({
  default: "default",
  crosshair: "crosshair",
  grab: "open-hand",
  grabbing: "closed-hand",
  "ew-resize": "resize-left-right",
});

export function useNativeEditorCursor(): (
  cursor: PianoRollCursor,
  refresh?: boolean,
) => void {
  const currentKind = useRef<EditorCursorKind>("default");
  const pendingKind = useRef<EditorCursorKind>("default");
  const pendingFrame = useRef<number | null>(null);

  useEffect(() => () => {
    if (pendingFrame.current != null) cancelAnimationFrame(pendingFrame.current);
    void setEditorCursor("default");
  }, []);

  return (cursor, refresh = false) => {
    const kind = NATIVE_CURSOR[cursor];
    pendingKind.current = kind;

    if (!refresh || kind !== currentKind.current) {
      currentKind.current = kind;
      void setEditorCursor(kind);
      return;
    }

    if (pendingFrame.current != null) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = null;
      currentKind.current = pendingKind.current;
      void setEditorCursor(pendingKind.current);
    });
  };
}
