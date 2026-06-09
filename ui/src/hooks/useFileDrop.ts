import { useEffect, useState } from "react";
import { useStore } from "../store";

// BRW-007 — drag-and-drop audio import for the JUCE WebView.
//
// A native juce::FileDragAndDropTarget overlay CANNOT win the OS drag hit-test
// over the embedded WKWebView NSView, so the path-based native approach was
// reverted. The working approach is bytes-over-bridge: the WKWebView DOES fire
// the HTML5 'drop' event with File objects (it only withholds the filesystem
// PATH, not the file contents). We read the dropped bytes via the File API,
// base64-encode them, and send them to the headless `import_clip_data` command,
// which decodes + validates + inserts a real (undoable) clip. The swappable
// seam is preserved: bytes go in via a MoshOps command, not native DnD.
//
// Mounted once from App. Returns whether a file drag is currently over the
// window so App can paint a "drop to import" affordance.

const AUDIO_EXTENSIONS = [".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg"];

function looksLikeAudio(file: File): boolean {
  const name = file.name.toLowerCase();
  if (AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  return file.type.startsWith("audio/");
}

// Robust chunked base64 encoder. Encoding a large Uint8Array via
// String.fromCharCode(...arr) spreads every byte as an argument and overflows
// the call stack on big files; chunk it so each fromCharCode call stays small.
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32 KB per chunk — well under the arg-count limit
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // DataTransfer.types is a DOMStringList/array — "Files" is present for OS file drags.
  return Array.prototype.indexOf.call(types, "Files") !== -1;
}

export function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // Depth counter so nested dragenter/dragleave over children don't flicker
    // the overlay off while the drag is still inside the window.
    let depth = 0;

    const onDragOver = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      // REQUIRED: stops the WKWebView from navigating to the dropped file:///
      // URL, and is what enables the subsequent 'drop' event to fire.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDragEnter = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };

    const onDragLeave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };

    const onDrop = (e: DragEvent) => {
      // Guard navigation even for non-audio drops; only import audio files.
      e.preventDefault();
      depth = 0;
      setDragging(false);

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      void (async () => {
        const store = useStore.getState();
        let imported = 0;
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          if (!looksLikeAudio(file)) continue; // ignore non-audio silently
          try {
            const buf = await file.arrayBuffer();
            const dataBase64 = toBase64(new Uint8Array(buf));
            await store.exec("import_clip_data", {
              name: file.name,
              dataBase64,
              trackId: useStore.getState().selectedTrackId ?? undefined,
              start: useStore.getState().snapshot?.transport.position ?? 0,
            });
            imported += 1;
          } catch (err) {
            useStore.setState({ lastError: `drop import failed: ${String(err)}` });
          }
        }
        if (imported > 0) await useStore.getState().refresh();
      })();
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return dragging;
}
