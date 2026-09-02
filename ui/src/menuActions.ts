// The single action dispatcher (CTL-002). Every File/Edit menu item — native macOS
// menu bar, WebView File menu, AND keyboard shortcut — funnels through runAction(),
// so "what an action does" is defined in exactly ONE place. Each action is a MoshOps
// command (or a UI-local store helper for clipboard/selection); nothing here mutates
// Tracktion directly. File pickers reuse the existing native dialogs (pick_files /
// pick_save_file) — they only resolve a path; the mutation is still a command.

import { runCaptureMidi } from "./captureMidi";
import { editorKeyFocused } from "./hooks/editorFocus";
import type { ActionId } from "./keymap";
import type { Snapshot } from "./types";
import { meterAt, snapStep, snapStepBeats, tempoMapFrom, barSeconds, SNAP_DIVISIONS, type SnapDiv } from "./time";
// The ruler-span selection the v2 and live shells draw (shift-drag on the ruler /
// empty-lane drag) lives in this UI-local slice; loop_toggle reads it. Reading it
// here never crosses the bridge — it only shapes the set_transport args.
import { useShell } from "./v2/shellState";
// The loop toggle's argument shaping is shared with the live shell's control bar
// (one rule: re-arm the existing range, default the first four bars when collapsed).
import { loopToggleArgs } from "./live/transportBar";
// The add-track command sequence (create_track, then add_midi_clip with the explicit
// trackId for mock/native parity) lives in exactly one place — the v2 lane list owns
// it, and the Live-12 ⌘T/⇧⌘T bindings ride it rather than duplicating the sequence.
import { addTrackOfKind } from "./v2/lanes/TrackLaneList";
import type { CommandResult } from "./types";

type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
// AGT-MEM (M3, item 5) — session summaries on project switch (see writeSessionSummary
// below, and sessionSummary.ts's own header for the design).
import { getSessionLog, clearSessionLog } from "./agent/memory/sessionLog";
import { buildSessionDigest, polishSessionSummary, type ChatFn } from "./agent/memory/sessionSummary";
import { enqueueTransportAction } from "./transportActionQueue";
import {
  FALLBACK_PROJECT_EXT,
  openProjectFilters,
  saveProjectDefaultName,
  saveProjectFilters,
} from "./projectFile";
import { recordZoom } from "./live/zoomHistory";

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
  transport: {
    playing: boolean;
    recording?: boolean;
    position?: number;
    // loop_toggle reads these; optional so older test fakes stay valid.
    looping?: boolean;
    loopStart?: number;
    loopEnd?: number;
  };
  // snap_toggle / grid_narrow / grid_widen / zoom_* read+drive these. All optional —
  // a fake (or a surface without the concern) simply makes the action a no-op.
  snap?: boolean;
  setSnap?: (b: boolean) => void;
  setSnapDivision?: (d: SnapDiv) => void;
  // grid_triplet (⌘3) reads+drives this — the arrangement's triplet-snap flag.
  snapTriplet?: boolean;
  setSnapTriplet?: (b: boolean) => void;
  pxPerSec?: number;
  setPxPerSec?: (v: number) => void;
  // The classic shell's range-tool span (ARR-010); the v2/live shells' span lives in
  // v2/shellState, which loop_toggle reads directly. Optional for test fakes.
  timeRange?: { start: number; end: number } | null;
  // select_all / invert_selection drive this; insert_midi_clip reads the selection's
  // track. Optional — a fake without them makes those actions no-ops.
  select?: (ids: string[]) => void;
  selectedTrackId?: string | null;
  reconcileTransport?: (transport: Partial<ActionStore["transport"]>) => void;
  projectTransitioning?: boolean;
  currentMode?: () => "idle" | "recording" | "reviewing";
  // Skill Foundry Slice B, Task 2 — the store's enterRecord now resolves to a
  // RecordingStoreOutcomeV1 this call site never inspects; Promise<unknown> keeps this
  // action-store shape decoupled from that result type.
  enterRecord?: (bar?: number) => Promise<unknown>;
  toggleRecord?: () => Promise<void>;
  snapshot?: Snapshot | null;
  clipboard?: unknown;
  setTool?: (tool: "move" | "split" | "range") => void;
  // FU-CLIP-NUDGE — the grid resolution nudge steps by. Optional so test fakes can
  // omit it (defaults to "1/4", the store's own default snap division).
  snapDivision?: SnapDiv;
  // Open editors. Keyboard focus decides whether a docked clip editor or the
  // arrangement owns Delete; automation remains modal and suppresses arrangement
  // deletion while open. Optional so test fakes can omit them.
  editingClipId?: string | null;
  automationTrackId?: string | null;
  // Taste loop (⌘⇧F) — opens the felt-wrong capture dialog. Optional for test fakes.
  setFeltWrongOpen?: (open: boolean) => void;
  // REC-001 (⇧⌘C) — Capture MIDI reports through the shared error banner, because
  // capturing NOTHING is the common outcome and is otherwise completely invisible.
  // Optional for test fakes.
  setLastError?: (message: string | null) => void;
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

// PRJ-NAME — the picker filters. The pure string logic (and the reasoning about which
// extension goes in which dialog) lives in projectFile.ts; these just read the
// backend-owned extension off the snapshot and hand it over.
const projectExt = (ctx: ActionCtx): string =>
  ctx.store.snapshot?.session.projectExtension || FALLBACK_PROJECT_EXT;

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
    // The polish is best-effort AND time-boxed: this await sits BEFORE the project
    // switch (the note belongs to the outgoing project), so an unreachable brain
    // must not hold the switch hostage. A hung /api/brain/chat costs ~2s and the
    // new_project application lands long after the caller has moved on — the
    // walkthrough/templates e2e race, where tracks added right after File → New
    // were wiped by the late switch. 300ms keeps a healthy local brain's polish
    // and falls back to the raw digest otherwise; the switch itself never waits
    // longer than that.
    const item = ctx.chat
      ? await Promise.race([
          polishSessionSummary(digest, ctx.chat),
          new Promise<string>((resolve) => setTimeout(() => resolve(digest), 300)),
        ])
      : digest;
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
  mode?: string;      // bounce_track: "inPlace" | "newTrack"
  trackId?: string;   // bounce_track: explicit target (the menu rows), else the selection
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

    // TPL-001 — the vocal recording template: the same lifecycle as New, with the
    // recipe (Backing + armed Vocal, count-in, overdub takes, a four-bar loop) composed
    // natively so a singer lands one Record press away from a stacked take.
    case "new_vocal_project": {
      const digest = sessionDigestFor(ctx);
      if (digest) await writeSessionSummary(ctx, digest);
      clearSessionLog();
      await store.exec("new_project", { template: "vocal" });
      await store.refresh();
      store.invalidateMemory?.();
      return;
    }

    case "open_project": {
      let file = opts.file;
      if (!file) {
        const r = await ctx.pickFiles({ title: "Open project", filters: openProjectFilters(projectExt(ctx)) });
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
      const r = await ctx.pickSaveFile({
        title: "Save project as",
        filters: saveProjectFilters(projectExt(ctx)),
        defaultName: saveProjectDefaultName(ctx.store.snapshot?.session.editFile ?? "", projectExt(ctx)),
      });
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
      // The piano roll can be docked and unfocused. Its local key layer and the app
      // shortcut router decide ownership from DOM focus before this action runs, so
      // editingClipId alone must not swallow an arrangement-owned Delete. Automation
      // remains modal and keeps its existing arrangement guard.
      if (store.automationTrackId || (store.editingClipId && editorKeyFocused())) return;
      for (const clipId of [...store.selection]) await store.exec("remove_clip", { clipId });
      store.clearSelection();
      return;
    }

    case "play_pause":
      await runTransportAction(store, { action: "toggle" });
      return;
    // ⇧Space — Live's Continue Playback: play from the current position; the stop
    // leaves the playhead where it halted (Space's stop returns to the insert
    // marker). The marker/flag live in the engine (not undoable).
    case "continue_play":
      await runTransportAction(store, { action: "continue" });
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
      // Live groups the selected TRACKS: with no clips selected, the track-header
      // selection is the target (the clips path above stays the primary).
      const effective = trackIds.length > 0
        ? trackIds
        : store.selectedTrackId &&
            !(store.snapshot?.tracks.find((t) => t.id === store.selectedTrackId)?.isGroup)
          ? [store.selectedTrackId!]
          : [];
      if (effective.length) await store.exec("create_group_track", { trackIds: effective });
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
    // ↑/↓ — move every selected clip to the adjacent track (Live's cross-track nudge).
    // Adjacency is the ARRANGEMENT's visible ordering (group/return excluded — the same
    // filter the lanes use). A clip that can't move (no track above/below) stays put,
    // same edge posture as the ←/→ nudge's clamp-at-zero.
    case "nudge_up":
    case "nudge_down": {
      const tracks = (store.snapshot?.tracks ?? []).filter((t) => !t.isGroup && !t.isReturn);
      if (tracks.length === 0) return;
      const dir = id === "nudge_up" ? -1 : 1;
      for (const track of tracks) {
        const idx = tracks.indexOf(track);
        const dest = tracks[idx + dir];
        if (!dest) continue;   // the boundary track has nowhere to go — drop, not error
        for (const clip of track.clips)
          if (store.selection.has(clip.id))
            await store.exec("move_clip", { clipId: clip.id, trackId: dest.id });
      }
      return;
    }
    // ⇧⌘G — Ungroup. Live unwraps the group CONTAINING the selection: the selected
    // group track itself, else the selected track's parent group.
    case "ungroup": {
      const tracks = store.snapshot?.tracks ?? [];
      const selected = tracks.find((t) => t.id === store.selectedTrackId);
      const group = selected?.isGroup
        ? selected
        : tracks.find((t) => t.isGroup && t.id === selected?.parentId);
      if (group) await store.exec("ungroup_track", { trackId: group.id });
      return;
    }
    // ⌘I — Insert Silence: over the drawn time selection when one exists, else one
    // bar at the playhead (insert_time splits straddling clips at the bounds itself).
    case "insert_silence": {
      const span = useShell.getState().timeRange ?? store.timeRange ?? null;
      const map = tempoMapFrom(store.snapshot?.session);
      const barLen = barSeconds(meterAt(map, store.transport.position ?? 0));
      const hasSpan = span && span.end - span.start > 1e-6;
      await store.exec("insert_time", {
        start: hasSpan ? span.start : (store.transport.position ?? 0),
        duration: hasSpan ? span.end - span.start : barLen,
      });
      return;
    }
    // ⌥⌘F — Create Fade: Live's default edge fade (4ms) on every selected AUDIO clip.
    // MIDI clips are skipped (fades are wave-clip data — set_clip_fade clamps the rest).
    case "create_fade": {
      const FADE_SEC = 0.004;   // Live's default fade length
      const selected = new Set(store.selection);
      for (const track of store.snapshot?.tracks ?? [])
        for (const clip of track.clips)
          if (selected.has(clip.id) && clip.type === "wave")
            await store.exec("set_clip_fade", { clipId: clip.id, fadeInSec: FADE_SEC, fadeOutSec: FADE_SEC });
      return;
    }
    case "seek":
      if (typeof opts.position === "number")
        await store.exec("set_transport", { position: opts.position });
      return;
    case "loop_region":
      if (typeof opts.loopStart === "number" && typeof opts.loopEnd === "number")
        await store.exec("set_transport", { loop: true, loopStart: opts.loopStart, loopEnd: opts.loopEnd });
      return;
    // ⌘L (Live 12, SPEC §8): loop the drawn time selection when there is one
    // (the v2/live ruler-span, else the classic range-tool span); without one it is
    // the plain loop toggle, sharing the control bar's collapsed-range rule.
    case "loop_toggle": {
      const span = useShell.getState().timeRange ?? store.timeRange ?? null;
      if (span && span.end - span.start > 1e-6) {
        await store.exec("set_transport", { loop: true, loopStart: span.start, loopEnd: span.end });
        return;
      }
      const t = store.transport;
      const map = tempoMapFrom(store.snapshot?.session);
      const barLen = barSeconds(meterAt(map, t.position ?? 0));
      await store.exec("set_transport", loopToggleArgs({
        playing: t.playing, recording: t.recording ?? false, position: t.position ?? 0,
        looping: t.looping ?? false, loopStart: t.loopStart ?? 0, loopEnd: t.loopEnd ?? 0,
      }, barLen));
      return;
    }
    // Live's `0` — deactivate the selected clip(s) (the routing mute IS the engine's
    // clip deactivation). Mixed selections DEACTIVATE everything, mirroring the note
    // editor's toggleActiveEdits: per-note flipping makes the key useless on a mixed
    // selection, and clips are no different.
    case "deactivate": {
      const selected = new Set(store.selection);
      const clips = (store.snapshot?.tracks ?? [])
        .flatMap((track) => track.clips)
        .filter((clip) => selected.has(clip.id));
      if (clips.length === 0) return;
      const anyActive = clips.some((clip) => !clip.mute);
      for (const clip of clips) await store.exec("set_clip_mute", { clipId: clip.id, mute: anyActive });
      return;
    }
    case "snap_toggle":
      if (store.setSnap) store.setSnap(!(store.snap ?? true));
      return;
    // ⌘3 — triplet arrangement grid: every snap step shortens to 2/3 (three in the
    // space of two), the same ratio the editor's T applies to its own grid.
    case "grid_triplet":
      if (store.setSnapTriplet) store.setSnapTriplet(!(store.snapTriplet ?? false));
      return;
    // ⌘J — Consolidate. The engine merges MIDI clips in one transaction; a selection
    // mixing in audio is refused there with a plain error (the render half of
    // consolidate is not built — see docs/live-clone/PARITY.md).
    case "consolidate": {
      const selected = new Set(store.selection);
      const clips = (store.snapshot?.tracks ?? [])
        .flatMap((t) => t.clips)
        .filter((c) => selected.has(c.id));
      if (clips.length === 0) return;
      const res = await store.exec("consolidate_clips", { clipIds: clips.map((c) => c.id) });
      if (!res.ok) store.setLastError?.(res.error ?? "Consolidate failed");
      else await store.refresh();
      return;
    }
    // ⇧⌘J — Crop Clip (Live 12, ARRANGEMENT-context): trim each selected clip to the
    // drawn time selection. Unlike insert_silence there is NO playhead fallback —
    // crop without a selection is meaningless, so it errors honestly (the toast,
    // the same channel other failed actions use). The engine owns the note/bounds
    // math and the no-overlap refusal, in one undo step.
    case "crop_clip": {
      const span = useShell.getState().timeRange ?? store.timeRange ?? null;
      const hasSpan = span != null && span.end - span.start > 1e-6;
      const selected = new Set(store.selection);
      const clips = (store.snapshot?.tracks ?? [])
        .flatMap((t) => t.clips)
        .filter((c) => selected.has(c.id));
      if (clips.length === 0) { store.setLastError?.("Crop Clip: no clips selected"); return; }
      if (!hasSpan) { store.setLastError?.("Crop Clip needs a time selection"); return; }
      const res = await store.exec("crop_clip", { clipIds: clips.map((c) => c.id), start: span.start, end: span.end });
      if (!res.ok) store.setLastError?.(res.error ?? "Crop failed");
      else await store.refresh();
      return;
    }
    // ⌘B — Bounce to New Track (Live 12, Edit menu): offline-render the selected
    // track's output onto a new track below it. opts.mode "inPlace" is the menu
    // row's other form (replace the track's clips, keep the devices). Engine owns
    // the render + the honest refusals (empty / group / return / master).
    case "bounce_track": {
      const mode = opts.mode === "inPlace" ? "inPlace" : "newTrack";
      const trackId = opts.trackId ?? store.selectedTrackId;
      if (!trackId) { store.setLastError?.("Bounce: no track selected"); return; }
      const res = await store.exec("bounce_track", { trackId, mode });
      if (!res.ok) store.setLastError?.(res.error ?? "Bounce failed");
      else await store.refresh();
      return;
    }
    // ⌥⇧⌘F — Freeze Track (Live 12, Edit menu): render the track through its chain,
    // swap the clips for the render, park the devices. The same key UNFREEZES a
    // frozen track (Live's toggle) — the engine owns both honest refusals and the
    // frozen-editing lock; undo(freeze) is how the original clips return.
    case "freeze_track": {
      const trackId = opts.trackId ?? store.selectedTrackId;
      if (!trackId) { store.setLastError?.("Freeze: no track selected"); return; }
      const frozen = store.snapshot?.tracks.find((t) => t.id === trackId)?.frozen === true;
      const res = await store.exec(frozen ? "unfreeze_track" : "freeze_track", { trackId });
      if (!res.ok) store.setLastError?.(res.error ?? (frozen ? "Unfreeze failed" : "Freeze failed"));
      else await store.refresh();
      return;
    }
    // ⌘1/⌘2 — step the ARRANGEMENT grid division finer/coarser (SNAP_DIVISIONS is
    // coarse→fine). The open clip editor owns these keys for its own grid; the
    // dispatcher's gate in useKeyboardShortcuts is what keeps the two apart.
    case "grid_narrow":
    case "grid_widen": {
      if (!store.setSnapDivision) return;
      const cur = store.snapDivision ?? "1/4";
      const i = SNAP_DIVISIONS.indexOf(cur);
      const next = SNAP_DIVISIONS[Math.max(0, Math.min(SNAP_DIVISIONS.length - 1,
        i + (id === "grid_narrow" ? 1 : -1)))];
      if (next !== cur) store.setSnapDivision(next);
      return;
    }
    // ⌘+/⌘− — arrangement horizontal zoom (the store's setter owns the 20..400 clamp).
    // Records the pre-zoom view into Live's zoom history first (X pops it).
    case "zoom_in":
      recordZoom();
      if (store.setPxPerSec && typeof store.pxPerSec === "number") store.setPxPerSec(store.pxPerSec * 1.25);
      return;
    case "zoom_out":
      recordZoom();
      if (store.setPxPerSec && typeof store.pxPerSec === "number") store.setPxPerSec(store.pxPerSec / 1.25);
      return;

    // ── Wave 0 (menus.json ground truth) ─────────────────────────────────────
    // ⌘T / ⇧⌘T — insert a track. The exact command sequence (and its mock/native
    // parity rules) is addTrackOfKind's — see v2/lanes/TrackLaneList.tsx.
    case "insert_audio_track":
      await addTrackOfKind("audio", store.exec as ExecFn);
      return;
    case "insert_midi_track":
      await addTrackOfKind("midi", store.exec as ExecFn);
      return;
    // ⇧⌘M — an empty MIDI clip over the drawn time selection, else one bar at the
    // playhead, on the selected (else first) lane-track.
    case "insert_midi_clip": {
      const tracks = (store.snapshot?.tracks ?? []).filter((t) => !t.isGroup && !t.isReturn);
      const trackId = tracks.some((t) => t.id === store.selectedTrackId)
        ? store.selectedTrackId!
        : tracks[0]?.id;
      if (!trackId) return;
      const span = useShell.getState().timeRange ?? store.timeRange ?? null;
      const map = tempoMapFrom(store.snapshot?.session);
      const barLen = barSeconds(meterAt(map, store.transport.position ?? 0));
      const hasSpan = span && span.end - span.start > 1e-6;
      await store.exec("add_midi_clip", {
        trackId,
        start: hasSpan ? span.start : (store.transport.position ?? 0),
        length: hasSpan ? span.end - span.start : barLen,
      });
      return;
    }
    // ⌘U arrangement-side — quantize the SELECTED clips' notes to the current
    // arrangement grid (the open editor owns ⌘U for its own grid + swing; the
    // dispatcher gate in useKeyboardShortcuts keeps the two apart). No-op for wave
    // clips and empty MIDI clips. quantize_notes' division is in BEATS (0.5 = 1/8),
    // hence snapStepBeats — snapStep answers in seconds.
    case "quantize": {
      const map = tempoMapFrom(store.snapshot?.session);
      const division = store.snapDivision ?? "1/4";
      for (const track of store.snapshot?.tracks ?? [])
        for (const clip of track.clips)
          if (store.selection.has(clip.id) && (clip.notes?.length ?? 0) > 0)
            await store.exec("quantize_notes", {
              clipId: clip.id,
              division: snapStepBeats(meterAt(map, clip.start), division),
            });
      return;
    }
    // ⇧⌘L — Select Loop: draw the armed loop range as a time selection (the inverse
    // of ⌘L-over-a-span). Inert when no loop is armed, like Live.
    case "select_loop": {
      const t = store.transport;
      if (t.looping && typeof t.loopStart === "number" && typeof t.loopEnd === "number"
          && t.loopEnd - t.loopStart > 1e-6)
        useShell.getState().setTimeRange({ start: t.loopStart, end: t.loopEnd });
      return;
    }
    // ⌘A / ⇧⌘A at the ARRANGEMENT scope (clips). The open editor owns both for its
    // notes — the dispatcher's gate keeps the scopes apart.
    case "select_all": {
      const ids = (store.snapshot?.tracks ?? []).flatMap((t) => t.clips.map((c) => c.id));
      if (ids.length > 0) store.select?.(ids);
      return;
    }
    case "invert_selection": {
      const ids = (store.snapshot?.tracks ?? [])
        .flatMap((t) => t.clips.map((c) => c.id))
        .filter((id) => !store.selection.has(id));
      store.select?.(ids);
      return;
    }
    case "capture_midi": {
      // REC-001 — the ⇧⌘C door onto the same helper the transport button uses, so the
      // two can't drift into reporting the outcome differently.
      const { message } = await runCaptureMidi(store.exec);
      store.setLastError?.(message);
      return;
    }
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
  { id: "new_vocal_project", label: "New Vocal Recording", accel: "" },
  { id: "open_project", label: "Open…", accel: "⌘O" },
  { id: "save", label: "Save", accel: "⌘S" },
  { id: "save_as", label: "Save As…", accel: "⇧⌘S" },
  { id: "export_audio", label: "Export Audio…", accel: "⇧⌘R" },
];

/** FILE_MENU minus Export — the project-lifecycle actions on their own. Three surfaces
 *  had grown their own local `FILE_MENU.filter(m => m.id !== "export_audio")` (Export
 *  lives in its own panel wherever these appear); naming it once keeps a new surface from
 *  inventing a fourth ordering. */
export const PROJECT_MENU: MenuItemMeta[] = FILE_MENU.filter((m) => m.id !== "export_audio");
