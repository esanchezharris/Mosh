// CAP-AUT-006 — what a track's mute button should SAY, given that a track can now be
// silenced two independent ways.
//
// `track.mute` is the routing mute the button toggles (set_track_mute). A mute CURVE on
// the track's mute gate is a separate thing that also silences the track, and it moves on
// its own as the playhead crosses it — it arrives on the 30 Hz "mute_automation" rail,
// never in the snapshot, so a mute edge does not re-create the snapshot object.
//
// The rule this encodes, and why:
//
//   - LIT follows silence, not the button's own flag. A track that a curve has muted is
//     silent; a button that still looks open while the track is silent is the exact class
//     of convincing lie this repo keeps paying for.
//   - aria-pressed keeps following `track.mute` — the thing the button actually toggles.
//     Reporting effective silence there would tell a screen-reader user the control is
//     "pressed" and then do nothing recognisable when they press it again.
//   - the accessible name carries the automation instead, so the distinction is spoken
//     rather than only coloured.
//
// Pure and shared so every mute button in the shell agrees; the shells used to each
// re-derive `track.mute ? "on" : ""` inline, which is how they would drift apart.

export type MuteAutomation = Record<string, boolean>;

export type MuteButtonState = {
  /** The track is silent right now, by either route — drives the lit style. */
  silenced: boolean;
  /** This track's mute is under a curve — drives the "don't expect this to stay put" style. */
  automated: boolean;
  /** A curve, not the button, is what is silencing it right now. */
  mutedByAutomation: boolean;
  /** What the button toggles, and therefore what aria-pressed must report. */
  pressed: boolean;
  className: string;
  label: string;
};

/** `automation` holds ONLY tracks whose mute is automated — presence is the signal, the
 *  boolean is whether the curve has it closed at the playhead right now. */
export function muteButtonState(
  track: { id: string; mute?: boolean } | null | undefined,
  automation: MuteAutomation | undefined,
  base = "",
): MuteButtonState {
  const pressed = !!track?.mute;
  const id = track?.id ?? "";
  const automated = !!automation && Object.prototype.hasOwnProperty.call(automation, id);
  const mutedByAutomation = automated && automation![id] === true;
  const silenced = pressed || mutedByAutomation;

  const className = [base, silenced ? "on" : "", automated ? "automated" : ""]
    .filter(Boolean)
    .join(" ");

  // Spoken/hover text says WHICH mute is in force, so "why is this lit when I never
  // pressed it" is answerable without opening the automation panel.
  const label = mutedByAutomation
    ? "Mute — muted by automation"
    : automated
      ? "Mute — automated"
      : "Mute";

  return { silenced, automated, mutedByAutomation, pressed, className, label };
}
