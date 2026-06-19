// The single action dispatcher (CTL-002). Every File/Edit menu item — native macOS
// menu bar, WebView File menu, AND keyboard shortcut — funnels through runAction(),
// so "what an action does" is defined in exactly ONE place. Each action is a MoshOps
// command (or a UI-local store helper for clipboard/selection); nothing here mutates
// Tracktion directly. File pickers reuse the existing native dialogs (pick_files /
// pick_save_file) — they only resolve a path; the mutation is still a command.

import type { ActionId } from "./keymap";

export type { ActionId };

/** The store surface runAction reads. The real Zustand store satisfies this
 *  structurally; tests pass a fake so each action's command is asserted directly. */
export interface ActionStore {
  exec: (command: string, args?: Record<string, unknown>) => Promise<{ ok: boolean }>;
  refresh: () => Promise<void>;
  copySelection: () => void;
  cutSelection: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  clearSelection: () => void;
  selection: Set<string>;
  transport: { playing: boolean };
}

export interface ActionCtx {
  store: ActionStore;
  pickFiles: (opts?: { multiple?: boolean; filters?: string; title?: string }) => Promise<{ ok: boolean; files: string[] }>;
  pickSaveFile: (opts?: { filters?: string; title?: string; defaultName?: string }) => Promise<{ ok: boolean; file: string }>;
}

// Audio export formats the backend understands; the rest infer to WAV.
function formatForFile(path: string): "wav" | "aiff" | "flac" {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "aiff" || ext === "aif") return "aiff";
  if (ext === "flac") return "flac";
  return "wav";
}

/** Dispatch a logical action. `opts.file` lets Open Recent open a known path without
 *  popping the picker. Returns a promise so callers can await structural changes. */
export async function runAction(id: ActionId, ctx: ActionCtx, opts: { file?: string } = {}): Promise<void> {
  const { store } = ctx;
  switch (id) {
    case "new_project":
      await store.exec("new_project");
      await store.refresh();
      return;

    case "open_project": {
      let file = opts.file;
      if (!file) {
        const r = await ctx.pickFiles({ title: "Open project" });
        if (!r.ok || !r.files[0]) return;
        file = r.files[0];
      }
      await store.exec("open_project", { file });
      await store.refresh();
      return;
    }

    case "save":
      await store.exec("save");
      return;

    case "save_as": {
      const r = await ctx.pickSaveFile({ title: "Save project as" });
      if (!r.ok || !r.file) return;
      await store.exec("save_as", { file: r.file });
      await store.refresh();
      return;
    }

    case "export_audio": {
      const r = await ctx.pickSaveFile({ title: "Export audio", defaultName: "mix.wav" });
      if (!r.ok || !r.file) return;
      await store.exec("export_audio", { file: r.file, format: formatForFile(r.file), bitDepth: 24 });
      return;
    }

    case "undo":
      await store.exec("undo");
      return;
    case "redo":
      await store.exec("redo");
      return;

    case "copy":
      store.copySelection();
      return;
    case "cut":
      await store.cutSelection();
      return;
    case "paste":
      await store.pasteClipboard();
      return;

    case "delete": {
      for (const clipId of [...store.selection]) await store.exec("remove_clip", { clipId });
      store.clearSelection();
      return;
    }

    case "play_pause":
      await store.exec("set_transport", { action: "toggle" });
      return;
  }
}

/** Display label + accelerator hint for the menu surfaces. The native menu derives
 *  its real key-equivalents from the keymap; these strings are presentation. */
export interface MenuItemMeta {
  id: ActionId;
  label: string;
  accel: string;
}

/** The File menu, in display order. The "Open Recent" submenu is inserted by the
 *  renderer between Open and Save. Shared by the native menu and the WebView menu. */
export const FILE_MENU: MenuItemMeta[] = [
  { id: "new_project", label: "New", accel: "⌘N" },
  { id: "open_project", label: "Open…", accel: "⌘O" },
  { id: "save", label: "Save", accel: "⌘S" },
  { id: "save_as", label: "Save As…", accel: "⇧⌘S" },
  { id: "export_audio", label: "Export Audio…", accel: "⌘E" },
];
