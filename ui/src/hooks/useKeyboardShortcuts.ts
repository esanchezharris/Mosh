import { useEffect } from "react";
import { useStore } from "../store";

// Global keyboard-shortcut layer (CTL-002). Mounted once from App via a window
// 'keydown' listener. Every binding routes through the existing command surface
// (exec) or the UI-local clipboard/tool actions — no new mutation path. This is the
// SINGLE global key handler in the app: Delete/clip handling was consolidated here
// from Arrangement.tsx, so add new bindings here (not a second window listener).
//
// Shortcut map (Mod = Cmd on macOS / Ctrl elsewhere):
//   Space            play/stop toggle
//   R                record
//   Mod+Z            undo            Mod+Shift+Z   redo
//   Mod+S            save
//   Delete/Backspace remove selected clip(s)
//   Mod+C/X/V        copy / cut / paste clip
//   Mod+D            duplicate selected clip(s)
//   Mod+G            group the selected clips' tracks (submix)
//   Home / End       transport to start / end
//   1 / 2            move tool / split tool (pure-view)
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never hijack typing: a track-name input, number-field drag, textarea,
      // select, or any contentEditable element keeps full keyboard control.
      const target = (e.target as HTMLElement | null) ?? null;
      const active = document.activeElement as HTMLElement | null;
      const isEditable = (el: HTMLElement | null) =>
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (isEditable(target) || isEditable(active)) return;

      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const selected = () => [...s.selection];

      // Modifier combos first (Mod = Cmd/Ctrl).
      if (mod) {
        switch (e.key.toLowerCase()) {
          case "z":
            e.preventDefault();
            void s.exec(e.shiftKey ? "redo" : "undo");
            return;
          case "s":
            e.preventDefault(); // stop the browser "Save page" dialog
            void s.exec("save");
            return;
          case "c":
            e.preventDefault();
            s.copySelection();
            return;
          case "x":
            e.preventDefault();
            void s.cutSelection();
            return;
          case "v":
            e.preventDefault();
            void s.pasteClipboard();
            return;
          case "d":
            e.preventDefault(); // stop the browser bookmark dialog
            for (const id of selected()) void s.exec("duplicate_clip", { clipId: id });
            return;
          case "g": {
            // MIX-008 — group the tracks of the selected clips into a submix.
            e.preventDefault();
            const sel = new Set(selected());
            const trackIds =
              s.snapshot?.tracks
                .filter((t) => !t.isGroup && t.clips.some((c) => sel.has(c.id)))
                .map((t) => t.id) ?? [];
            if (trackIds.length > 0) void s.exec("create_group_track", { trackIds });
            return;
          }
          default:
            return; // leave other Mod combos to the browser
        }
      }

      switch (e.key) {
        case " ": // Space — play/stop
          e.preventDefault();
          void s.exec("set_transport", {
            action: s.snapshot?.transport.playing ? "stop" : "play",
          });
          return;
        case "r":
        case "R":
          void s.exec("set_transport", { action: "record" });
          return;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          for (const id of selected()) void s.exec("remove_clip", { clipId: id });
          s.clearSelection(); // match the prior Arrangement behavior (clear after delete)
          return;
        case "Home":
          e.preventDefault(); // the timeline is scrollable — keep Home as transport-only
          void s.exec("set_transport", { action: "to_start" });
          return;
        case "End":
          e.preventDefault();
          void s.exec("set_transport", { action: "to_end" });
          return;
        case "1":
          s.setTool("move");
          return;
        case "2":
          s.setTool("split");
          return;
        case "3":
          s.setTool("range");
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
