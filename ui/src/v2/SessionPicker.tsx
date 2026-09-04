// Session picker — shown once per app launch, over the already-loaded project.
//
// The app has always reopened the last edit silently (MoshEngine.cpp: "gap 2 — reopen the
// last project on relaunch"), and the only way to start clean was ⌘N or a "+" glyph in the
// composer bar whose tooltip reads "File · options · export". So a session accumulated
// tracks across its whole lifetime and nothing in-product ever offered a way out. That is
// what produced the 8-mostly-empty-tracks screenshot this work started from — not a
// default-tracks bug: `new_project` provably yields ZERO tracks (SelfTest.cpp), and the
// arrangement already shrink-wraps to its real track count.
//
// This is a pure-UI overlay, NOT a change to native startup. The edit loads behind it; the
// first click either dismisses it (zero commands) or issues one already-existing command.
// Teaching MoshEngine not to auto-load would mean touching the ctor every harness,
// --selftest, --run-script, multiplayer and recovery path depends on, to buy something the
// UI can produce for free.
//
// Shown on EVERY launch rather than on a heuristic: the session that prompted this had 8
// tracks, so any "looks unstarted" test would have stayed silent in exactly the case that
// matters. Continue is the autofocused primary and both Enter and Escape map to it, so the
// old behaviour costs one keystroke.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useShell } from "./shellState";
import { isRealNative, pickFiles, pickSaveFile, brainChat } from "../bridge";
import { devPickerOverride } from "./pickerQuery";
import { runAction } from "../menuActions";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import type { Snapshot } from "../types";
import { projectLabel } from "../projectFile";   // PRJ-NAME — one shared implementation
import { RecordingSetup } from "./RecordingSetup";

/** Pure visibility rule, testable without a DOM (mirrors shouldShowRecoveryNotice). */
export function shouldShowSessionPicker(
  snapshot: Snapshot | null,
  dismissed: boolean,
  eligible: boolean,
): boolean {
  if (!eligible || dismissed || !snapshot) return false;
  // A refused-newer-format project owns the screen — offering to "continue" into an
  // edit the engine declined to load would be a lie.
  if (snapshot.session.loadError) return false;
  // Same for crash recovery: that notice is a decision about THIS project, and it has to
  // be answered before a chooser makes any sense.
  if (snapshot.session.recoveryAvailable) return false;
  return true;
}

/** Tracks as the ARRANGEMENT counts them — the same filter TrackLaneList applies, so the
 *  number here is the number the user is about to see. Buses/returns and group folders
 *  are real tracks but never appear as lanes. */
export function visibleTrackCount(snapshot: Snapshot): number {
  return snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn).length;
}


export function SessionPicker() {
  const snapshot = useStore((s) => s.snapshot);
  const dismissed = useShell((s) => s.sessionPickerDismissed);
  const dismiss = useShell((s) => s.dismissSessionPicker);
  const busyRef = useRef(false);
  const continueRef = useRef<HTMLButtonElement | null>(null);

  const eligible = isRealNative() || devPickerOverride();
  const open = shouldShowSessionPicker(snapshot, dismissed, eligible);

  // Escape === Continue. A picker that Escapes into a blank screen at launch would be a
  // worse bug than the one this fixes.
  useEscapeToClose(open, dismiss);
  useEffect(() => { if (open) continueRef.current?.focus(); }, [open]);

  if (!open || !snapshot) return null;

  const ctx = () => ({ store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat });
  const run = async (id: "new_project" | "open_recent", opts?: { index: number }) => {
    if (busyRef.current) return;
    busyRef.current = true;
    // Everything goes through runAction, never store.exec: it also writes the agent-memory
    // session summary, clears the session log, refreshes and invalidates memory, and its
    // own header calls that ordering load-bearing.
    try { await runAction(id, ctx(), opts); } finally { busyRef.current = false; dismiss(); }
  };

  const current = snapshot.session.editFile ?? "";
  const trackCount = visibleTrackCount(snapshot);
  // The current project is already "Continue" — listing it again as a Recent row is noise.
  // Each surviving row keeps its ORIGINAL index, because open_recent resolves an index
  // against the native list, not against what we chose to render.
  const recents = (snapshot.session.recentProjects ?? [])
    .map((p, index) => ({ ...p, index }))
    .filter((p) => p.path !== current)
    .slice(0, 6);

  return (
    <div className="v2-picker-backdrop" role="dialog" aria-modal="true" aria-label="Open a session"
      data-testid="v2-session-picker">
      <div className="v2-picker">
        <div className="v2-picker-head">
          <strong className="display">MOSH</strong>
          <span>Start where you want.</span>
        </div>

        <button ref={continueRef} className="v2-picker-choice primary" data-testid="v2-picker-continue"
          onClick={dismiss}>
          <span className="v2-picker-choice-title">Continue<kbd>⏎</kbd></span>
          {/* This line is the point of the whole screen: it makes an accumulated session
              legible BEFORE it fills the arrangement. */}
          <span className="v2-picker-choice-sub">
            {projectLabel(current) || "current session"} · {trackCount} {trackCount === 1 ? "track" : "tracks"}
          </span>
        </button>

        <button className="v2-picker-choice" data-testid="v2-picker-new" onClick={() => void run("new_project")}>
          <span className="v2-picker-choice-title">Start empty</span>
          <span className="v2-picker-choice-sub">
            A blank session — {projectLabel(current) || "this one"} stays saved and in Recent.
          </span>
        </button>

        <RecordingSetup />

        {recents.length > 0 && (
          <div className="v2-picker-recent" data-testid="v2-picker-recents">
            <span className="v2-picker-label">Recent</span>
            {recents.map((p) => (
              <button key={p.path} className="v2-picker-row" data-testid="v2-picker-recent"
                onClick={() => void run("open_recent", { index: p.index })}>
                {p.name || projectLabel(p.path)}
              </button>
            ))}
          </div>
        )}

        <div className="v2-picker-foot">Esc to continue</div>
      </div>
    </div>
  );
}
