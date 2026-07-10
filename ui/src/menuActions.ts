// The single action dispatcher (CTL-002). Every File/Edit menu item — native macOS
// menu bar, WebView File menu, AND keyboard shortcut — funnels through runAction(),
// so "what an action does" is defined in exactly ONE place. Each action is a MoshOps
// command (or a UI-local store helper for clipboard/selection); nothing here mutates
// Tracktion directly. File pickers reuse the existing native dialogs (pick_files /
// pick_save_file) — they only resolve a path; the mutation is still a command.

import type { ActionId } from "./keymap";
import type { Snapshot } from "./types";

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
  transport: { playing: boolean; position?: number };
  snapshot?: Snapshot | null;
  clipboard?: unknown;
  setTool?: (tool: "move" | "split" | "range") => void;
  // open clip-editor modals — Delete is suppressed on the arrangement while either
  // is set (the editor owns Delete then). Optional so test fakes can omit them.
  editingClipId?: string | null;
  automationTrackId?: string | null;
}

export interface ActionCtx {
  store: ActionStore;
  pickFiles: (opts?: { multiple?: boolean; filters?: string; title?: string }) => Promise<{ ok: boolean; files: string[] }>;
  pickSaveFile: (opts?: { filters?: string; title?: string; defaultName?: string }) => Promise<{ ok: boolean; file: string }>;
}

export interface RunActionOptions {
  file?: string;
  index?: number;
  position?: number;
  loopStart?: number;
  loopEnd?: number;
}

// Audio export formats the backend understands; the rest infer to WAV.
function formatForFile(path: string): "wav" | "aiff" | "flac" {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "aiff" || ext === "aif") return "aiff";
  if (ext === "flac") return "flac";
  return "wav";
}

/** Dispatch a logical action. `opts.file` lets `open_project` open a known path without
 *  popping the picker; `opts.index` selects which entry `open_recent` reopens (0 = newest).
 *  Returns a promise so callers can await structural changes. */
export async function runAction(id: ActionId, ctx: ActionCtx, opts: RunActionOptions = {}): Promise<void> {
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

    // Open Recent — reopen a project by its position in session.recentProjects
    // (0 = most-recent). The backend resolves the index to a path itself, so the
    // UI never has to round-trip a stale path; out-of-range degrades to an error
    // result the seam reports. Replaces the Edit, so refresh() resyncs the snapshot.
    case "open_recent": {
      const index = opts.index ?? 0;
      await store.exec("open_recent", { index });
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
      // While a clip-editor modal is open (piano roll / automation), Delete belongs
      // to that editor (delete selected notes/points), not the arrangement — bail so
      // we never silently remove the clip being edited (Phase 1 fix, preserved here).
      if (store.editingClipId || store.automationTrackId) return;
      for (const clipId of [...store.selection]) await store.exec("remove_clip", { clipId });
      store.clearSelection();
      return;
    }

    case "play_pause":
      await store.exec("set_transport", { action: "toggle" });
      return;
    case "record":
      await store.exec("set_transport", { action: "record" });
      return;
    case "to_start":
      await store.exec("set_transport", { action: "to_start" });
      return;
    case "to_end":
      await store.exec("set_transport", { action: "to_end" });
      return;
    case "duplicate":
      for (const clipId of [...store.selection]) await store.exec("duplicate_clip", { clipId });
      return;
    case "group": {
      const selected = new Set(store.selection);
      const trackIds = store.snapshot?.tracks
        .filter((track) => !track.isGroup && track.clips.some((clip) => selected.has(clip.id)))
        .map((track) => track.id) ?? [];
      if (trackIds.length) await store.exec("create_group_track", { trackIds });
      return;
    }
    case "split": {
      const position = opts.position ?? store.transport.position;
      if (typeof position !== "number") return;
      for (const track of store.snapshot?.tracks ?? [])
        for (const clip of track.clips)
          if (store.selection.has(clip.id) && clip.start < position && position < clip.start + clip.length)
            await store.exec("split_clip", { clipId: clip.id, time: position });
      return;
    }
    case "tool_move":
      store.setTool?.("move");
      return;
    case "tool_split":
      store.setTool?.("split");
      return;
    case "tool_range":
      store.setTool?.("range");
      return;
    case "seek":
      if (typeof opts.position === "number")
        await store.exec("set_transport", { position: opts.position });
      return;
    case "loop_region":
      if (typeof opts.loopStart === "number" && typeof opts.loopEnd === "number")
        await store.exec("set_transport", { loop: true, loopStart: opts.loopStart, loopEnd: opts.loopEnd });
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
