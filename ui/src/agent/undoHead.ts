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
// fails if its handler opens an undo transaction.

/** Moves along the undo timeline itself (mirrors store.ts's HISTORY_MOVES). */
const HISTORY_MOVES = new Set(["undo", "redo", "jump_to_history"]);

/** Successful commands that leave the undo head where it was. */
export const KEEPS_UNDO_HEAD: ReadonlySet<string> = new Set([
  // Reads (every get_* / list_* is also a read; see movesUndoHead).
  "file_peaks", "batch_status", "loop_state", "agent_memory_read", "training_job_status",
  "mp_serialize_track", "mp_serialize_project", "mp_sync_locks",
  // Transport and audition: sound and position, never an edit.
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
  // Persistence and the local issue log.
  "save", "save_as", "export_audio", "export_stems",
  "report_issue", "update_issue", "export_issue", "attach_issue_file",
  // Multiplayer signalling.
  "mp_broadcast_selection", "mp_send_signal",
]);

/** True when a successful `command` may have put a new step on (or moved along) the undo
 *  timeline — i.e. a receipt that undoes with plain `undo` is no longer about its own batch. */
export function movesUndoHead(command: string): boolean {
  if (HISTORY_MOVES.has(command)) return true;
  if (command.startsWith("get_") || command.startsWith("list_")) return false;
  return !KEEPS_UNDO_HEAD.has(command);
}
