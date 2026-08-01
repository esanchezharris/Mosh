// The single action dispatcher (CTL-002). Every File/Edit menu item — native macOS
// menu bar, WebView File menu, AND keyboard shortcut — funnels through runAction(),
// so "what an action does" is defined in exactly ONE place. Each action is a MoshOps
// command (or a UI-local store helper for clipboard/selection); nothing here mutates
// Tracktion directly. File pickers reuse the existing native dialogs (pick_files /
// pick_save_file) — they only resolve a path; the mutation is still a command.

import type { ActionId } from "./keymap";
import type { Snapshot } from "./types";
import { meterAt, snapStep, tempoMapFrom, type SnapDiv } from "./time";
// AGT-MEM (M3, item 5) — session summaries on project switch (see writeSessionSummary
// below, and sessionSummary.ts's own header for the design).
import { getSessionLog, clearSessionLog } from "./agent/memory/sessionLog";
import { buildSessionDigest, polishSessionSummary, type ChatFn } from "./agent/memory/sessionSummary";
import { enqueueTransportAction } from "./transportActionQueue";

export type { ActionId };

/** The store surface runAction reads. The real Zustand store satisfies this
 *  structurally; tests pass a fake so each action's command is asserted directly. */
export interface ActionStore {
  exec: (command: string, args?: Record<string, unknown>) => Promise<{
    ok: boolean;
    command?: string;
    data?: unknown;
    error?: string;
  }>;
  refresh: () => Promise<void>;
  // AGT-MEM (M3) — drops the cached agent-memory pools (agent/memory/hydrate.ts) so
  // the NEXT retrieval re-fetches for whichever project is open. Optional so
  // existing test fakes (and any caller that doesn't care about memory) stay valid;
  // the real Zustand store always wires it. Called on every action that swaps the
  // underlying Edit (new_project/open_project/open_recent) — a stale project's
  // notes must never leak into the newly-opened one's prompts.
  invalidateMemory?: () => void;
  copySelection: () => void;
  cutSelection: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  clearSelection: () => void;
  selection: Set<string>;
  transport: { playing: boolean; recording?: boolean; position?: number };
  reconcileTransport?: (transport: Partial<ActionStore["transport"]>) => void;
  projectTransitioning?: boolean;
  currentMode?: () => "idle" | "recording" | "reviewing";
  enterRecord?: (bar?: number) => Promise<void>;
  toggleRecord?: () => Promise<void>;
  snapshot?: Snapshot | null;
  clipboard?: unknown;
  setTool?: (tool: "move" | "split" | "range") => void;
  // FU-CLIP-NUDGE — the grid resolution nudge steps by. Optional so test fakes can
  // omit it (defaults to "1/4", the store's own default snap division).
  snapDivision?: SnapDiv;
  // open clip-editor modals — Delete is suppressed on the arrangement while either
  // is set (the editor owns Delete then). Optional so test fakes can omit them.
  editingClipId?: string | null;
  automationTrackId?: string | null;
  // Taste loop (⌘⇧F) — opens the felt-wrong capture dialog. Optional for test fakes.
  setFeltWrongOpen?: (open: boolean) => void;
}

export interface ActionCtx {
  store: ActionStore;
  pickFiles: (opts?: { multiple?: boolean; filters?: string; title?: string }) => Promise<{ ok: boolean; files: string[] }>;
  pickSaveFile: (opts?: { filters?: string; title?: string; defaultName?: string }) => Promise<{ ok: boolean; file: string }>;
  // AGT-MEM (M3, item 5) — optional brain_chat polish for the outgoing project's
  // session-summary note (see writeSessionSummary). Omitted -> the raw deterministic
  // digest is written as-is (still a complete summary on its own); existing test fakes
  // that don't care about this stay valid unchanged.
  chat?: ChatFn;
}

// AGT-MEM (M3, item 5) — session summaries: a terse recap of THIS session's meaningful
// commands, written as a project-scope memory note for the project currently open (i.e.
// the one about to be REPLACED by new_project/open_project/open_recent) — so the next
// time this song is opened, Moshi's memory carries a short "what happened last time"
// instead of nothing.
//
// Split in two on purpose: sessionDigestFor() is a PURE, SYNCHRONOUS peek (no editFile,
// or nothing worth summarizing, both resolve to "" with zero async cost) — writeSession-
// Summary() is only ever called, and only ever awaited, when there is real work to do.
// This matters beyond tidiness: runAction is fired fire-and-forget (`void runAction(...)`)
// from a couple of call sites (e.g. the native-menu event handler in
// useKeyboardShortcuts.ts), where a caller inspects the resulting store.exec call
// synchronously-ish right after dispatch. Unconditionally awaiting an async function here
// — even one that does nothing — costs at least one extra microtask tick before the REAL
// store.exec(actionId, ...) fires, measurably shifting that timing. Gating the await on a
// synchronous "is there anything to do" check keeps the common (nothing-to-summarize)
// path exactly as fast as it was before this feature existed.
function sessionDigestFor(ctx: ActionCtx): string {
  const editFile = ctx.store.snapshot?.session.editFile ?? "";
  return editFile ? buildSessionDigest(getSessionLog()) : "";
}

// Best-effort by design: a failed write or a chat-polish failure must NEVER block or
// fail the project switch it's attached to — every failure path here is swallowed.
async function writeSessionSummary(ctx: ActionCtx, digest: string): Promise<void> {
  try {
    const item = ctx.chat ? await polishSessionSummary(digest, ctx.chat) : digest;
    await ctx.store.exec("agent_memory_write", { scope: "project", kind: "summary", item });
  } catch {
    // best-effort — see the function comment above
  }
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

function runRecordAction(store: ActionStore): Promise<void> {
  if (store.toggleRecord) return store.toggleRecord();
  return enqueueTransportAction(async () => {
    if (store.projectTransitioning) return;
    const recording = store.currentMode
      ? store.currentMode() === "recording"
      : store.transport.recording === true;
    if (store.enterRecord && !recording) {
      await store.enterRecord();
      return;
    }
    await store.exec("set_transport", { action: "record" });
  });
}

function runTransportAction(store: ActionStore, args: Record<string, unknown>): Promise<void> {
  return enqueueTransportAction(async () => {
    if (store.projectTransitioning) return;
    const result = await store.exec("set_transport", args);
    if (!result.ok || !result.data || typeof result.data !== "object") return;
    const data = result.data as Record<string, unknown>;
    const transport: Partial<ActionStore["transport"]> = {};
    if (typeof data.playing === "boolean") transport.playing = data.playing;
    if (typeof data.recording === "boolean") transport.recording = data.recording;
    if (typeof data.position === "number") transport.position = data.position;
    if (Object.keys(transport).length) store.reconcileTransport?.(transport);
  });
}

/** Dispatch a logical action. `opts.file` lets `open_project` open a known path without
 *  popping the picker; `opts.index` selects which entry `open_recent` reopens (0 = newest).
 *  Returns a promise so callers can await structural changes. */
export async function runAction(id: ActionId, ctx: ActionCtx, opts: RunActionOptions = {}): Promise<void> {
  const { store } = ctx;
  switch (id) {
    case "new_project": {
      // See sessionDigestFor/writeSessionSummary's comments: this synchronous check
      // means the common (nothing to summarize) path adds ZERO extra microtask ticks
      // before the real store.exec below — load-bearing for fire-and-forget callers
      // (e.g. the native-menu handler in useKeyboardShortcuts.ts) that inspect the
      // dispatched command right after calling runAction without awaiting it.
      const digest = sessionDigestFor(ctx);
      if (digest) await writeSessionSummary(ctx, digest);
      clearSessionLog();
      await store.exec("new_project");
      await store.refresh();
      store.invalidateMemory?.();
      return;
    }

    case "open_project": {
      let file = opts.file;
      if (!file) {
        const r = await ctx.pickFiles({ title: "Open project" });
        if (!r.ok || !r.files[0]) return;
        file = r.files[0];
      }
      const digest = sessionDigestFor(ctx);
      if (digest) await writeSessionSummary(ctx, digest);
      clearSessionLog();
      await store.exec("open_project", { file });
      await store.refresh();
      store.invalidateMemory?.();
      return;
    }

    // Open Recent — reopen a project by its position in session.recentProjects
    // (0 = most-recent). The backend resolves the index to a path itself, so the
    // UI never has to round-trip a stale path; out-of-range degrades to an error
    // result the seam reports. Replaces the Edit, so refresh() resyncs the snapshot.
    case "open_recent": {
      const index = opts.index ?? 0;
      const digest = sessionDigestFor(ctx);
      if (digest) await writeSessionSummary(ctx, digest);
      clearSessionLog();
      await store.exec("open_recent", { index });
      await store.refresh();
      store.invalidateMemory?.();
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
      await runTransportAction(store, { action: "toggle" });
      return;
    case "record":
      await runRecordAction(store);
      return;
    case "to_start":
      await runTransportAction(store, { action: "to_start" });
      return;
    case "to_end":
      await runTransportAction(store, { action: "to_end" });
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
    // FU-CLIP-NUDGE — fine-move every selected clip by a fixed increment: one step
    // of the current grid division (session/tempo-aware, via the same snapStep the
    // drag-time grid uses), evaluated at each clip's own position. This is a FIXED
    // step, independent of the drag-time snap toggle — it always applies, snap on
    // or off. Clamped so a clip can never nudge to a negative start.
    case "nudge_left":
    case "nudge_right": {
      const dir = id === "nudge_left" ? -1 : 1;
      const division = store.snapDivision ?? "1/4";
      const map = tempoMapFrom(store.snapshot?.session);
      for (const track of store.snapshot?.tracks ?? [])
        for (const clip of track.clips)
          if (store.selection.has(clip.id)) {
            const step = snapStep(meterAt(map, clip.start), division);
            await store.exec("move_clip", { clipId: clip.id, start: Math.max(0, clip.start + dir * step) });
          }
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
    case "felt_wrong":
      // Taste loop (workshop 2026-07-19): opens the capture dialog; the dialog itself
      // archives the row (no MoshOps command — the archive rides archive_pair).
      store.setFeltWrongOpen?.(true);
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

/** FILE_MENU minus Export — the project-lifecycle actions on their own. Three surfaces
 *  had grown their own local `FILE_MENU.filter(m => m.id !== "export_audio")` (Export
 *  lives in its own panel wherever these appear); naming it once keeps a new surface from
 *  inventing a fourth ordering. */
export const PROJECT_MENU: MenuItemMeta[] = FILE_MENU.filter((m) => m.id !== "export_audio");
