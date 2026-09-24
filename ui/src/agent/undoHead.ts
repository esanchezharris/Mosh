// D2 (demo readiness round 2) — does a successful command move the session's undo head?
//
// Why the UI needs to know: a Moshi receipt ("Set tempo to 90 BPM · Undo" in the V3 dock, the
// v2 toast, the classic Monster panel) undoes with a plain `undo`. That is only honest while
// the receipt's own batch is the newest undo step. Once any later command opens an undo step
// of its own — + Drum beat, a fader, ⌘Z — the same button would revert THAT instead. So
// store.exec retires the receipt after any successful command for which this returns true.
//
// The direction of failure is deliberate. A command missing from KEEPS_UNDO_HEAD counts as an
// edit, so an unlisted command can at worst hide a receipt early (its batch is still in the
// History list and on ⌘Z). An edit wrongly listed here would leave a stale Undo up, which is
// the defect itself — undoHead.test.ts re-derives every listed native command from MoshOps and
// fails if its handler opens an undo transaction, rewrites a clip's source reference, or lands a
// recorded take without being in LANDS_TAKE_WHILE_RECORDING.
//
// Known limit: this sees only commands that pass through the desktop WebView's store.exec. The
// phone pad's actions and edits inside a native plugin editor window reach MoshOps directly.

/** Moves along the undo timeline itself. store.ts bumps historyEpoch on exactly these. */
export const HISTORY_MOVES: ReadonlySet<string> = new Set(["undo", "redo", "jump_to_history"]);

/** Successful commands that leave the undo head where it was. */
export const KEEPS_UNDO_HEAD: ReadonlySet<string> = new Set([
  // Reads (every get_* / list_* is also a read; see movesUndoHead).
  "file_peaks", "batch_status", "loop_state", "agent_memory_read", "training_job_status",
  "mp_serialize_track", "mp_serialize_project", "mp_sync_locks",
  // Transport and audition: sound and position — except that a set_transport issued WHILE
  // RECORDING lands the take first (see LANDS_TAKE_WHILE_RECORDING).
  "set_transport", "audition_file", "stop_audition", "audition_note", "all_notes_off",
  // Device / engine preferences (TransactionSafe.h: NonUndoable).
  "set_metronome", "set_key", "set_count_in", "set_project_settings", "set_record_options",
  "set_input_monitor", "arm_track", "set_audio_device", "retry_audio_device",
  // Deliberately NOT here, though the header files them with these: set_track_output and the
  // meter commands call beginTxn in MoshOps (the drift guard caught it), and batch_begin opens
  // the batch's own step — only an agent ask sends one, and a new ask retires the old receipt.
  "set_buffer_size", "set_audio_threads", "set_track_input",
  "block_plugin", "unblock_plugin", "clear_plugin_blocklist", "mark_take",
  "open_plugin_editor", "open_master_plugin_editor",
  "loop_navigate", "loop_home", "loop_lead_in",
  // Agent memory (non-undoable by design, AGT-MEM M1) — also written fire-and-forget right
  // after a batch, so listing them keeps that write from retiring the batch's own receipt.
  "agent_memory_write", "agent_memory_delete", "agent_memory_clear",
  // Persistence and the local issue log. The exports land a take that is still recording (see
  // LANDS_TAKE_WHILE_RECORDING). Deliberately NOT here: save_as — MoshEngine::saveProjectAs
  // stops the transport (landing a live take) and consolidates audio into the new folder, and
  // both it and cmdSaveAs repoint clip sources (repointWaveClipSource), which Tracktion records
  // on the Edit's own UndoManager as a new step even when nothing is recording.
  "save", "export_audio", "export_stems",
  "report_issue", "update_issue", "export_issue", "attach_issue_file",
  // Multiplayer signalling. store/mp.ts claims the track on every track click; the claim only
  // stamps a logical id (null UndoManager). Deliberately NOT here: mp_commit_track, which
  // store/mp.ts sends every 20 s in a session — it repoints each wave clip to its by-hash copy
  // (SourceFileReference, written through the Edit's UndoManager: a new step 350 ms later), so
  // it retires a receipt. That is the harmless direction; the batch stays on ⌘Z and in History.
  "mp_broadcast_selection", "mp_send_signal", "mp_claim_track",
]);

/** KEEPS_UNDO_HEAD entries that land a recorded take when they run WHILE RECORDING.
 *  cmdSetTransport finalizes an active take (stop / toggle / record / to_start) through
 *  cmdStopRecording, and Tracktion adds the landed clip through the Edit's own UndoManager: a
 *  new undo step with no beginTxn anywhere. V3 ends every recording this way (TopBar Record →
 *  Record, Play/Pause, Stop). While recording, ANY set_transport counts — a seek mid-take hides
 *  the receipt early, which is the harmless direction (the dock hides it while recording
 *  anyway). The exports detach the Edit for their render with transport.stop(false, false),
 *  which lands the live take the same way; the V3 File menu offers them mid-take.
 *  stop_recording itself is not listed at all, so it always counts. */
export const LANDS_TAKE_WHILE_RECORDING: ReadonlySet<string> = new Set([
  "set_transport", "export_audio", "export_stems",
]);

export type UndoHeadContext = {
  /** The store's transport.recording BEFORE the command ran. */
  readonly recording?: boolean;
};

/** True when a successful `command` may have put a new step on (or moved along) the undo
 *  timeline — i.e. a receipt that undoes with plain `undo` is no longer about its own batch. */
export function movesUndoHead(command: string, context: UndoHeadContext = {}): boolean {
  if (HISTORY_MOVES.has(command)) return true;
  if (command.startsWith("get_") || command.startsWith("list_")) return false;
  if (context.recording === true && LANDS_TAKE_WHILE_RECORDING.has(command)) return true;
  return !KEEPS_UNDO_HEAD.has(command);
}

// ── the undo-head mark (round-2 review, finding 4) ────────────────────────────────────────
// Retiring the receipt in store.exec only works once the receipt is up. The dock clears the old
// receipt when an ask starts, and runAgentBatch hands the new one back only after the
// `await refresh()` that follows batch_end — the toolbar stays live meanwhile, so a fader move
// can land in that window with nothing to retire. So store.exec also counts every move here;
// the producer stamps the change set with the count right after its own batch_end
// (ChangeSet.undoHeadMark), and setAgentChangeSet refuses a stamp that is no longer current.

let undoHeadMoves = 0;

/** store.exec calls this after every successful command for which movesUndoHead is true. */
export function noteUndoHeadMove(): void {
  undoHeadMoves += 1;
}

/** The current position of the count. Two equal marks mean nothing moved the head in between. */
export function undoHeadMark(): number {
  return undoHeadMoves;
}
