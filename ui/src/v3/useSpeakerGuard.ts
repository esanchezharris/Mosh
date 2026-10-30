import { useEffect, useRef } from "react";
import { looksLikeSpeakers } from "./vocalSetup";

// The live half of the speaker guard (vocalSetup.ts holds the rules): headphones pulled
// out mid-session, or a relaunch that resets monitoring to automatic on a Mac playing
// through its own speakers, turns Hear myself off before the mic howls. Shared by the
// Booth and the Start page so the two can never disagree about it.
//
// A producer who turns Hear myself back ON over speakers (headphones with an odd name, a
// booth monitor they trust) is not overridden: `markOverride()` stands the guard down
// until the output device changes.

export interface SpeakerGuardInput {
  outputDevice: string;
  hearingMyself: boolean;
  takesTrackId: string | null | undefined;
  /** A monitoring change still waiting for the take to end: never fight it. */
  pendingMonitor: boolean;
  /** Turns monitoring off; resolves true when it applied (or is pending). */
  turnOff: (takesTrackId: string) => Promise<boolean>;
  /** Called after the guard turned monitoring off. */
  onMuted: (outputDevice: string) => void;
}

export function useSpeakerGuard({ outputDevice, hearingMyself, takesTrackId, pendingMonitor, turnOff, onMuted }: SpeakerGuardInput) {
  const onSpeakers = looksLikeSpeakers(outputDevice);
  const override = useRef(false);
  const muting = useRef(false);
  // The latest callbacks, so the effect below stays keyed on the CONDITIONS only.
  const actions = useRef({ turnOff, onMuted });
  actions.current = { turnOff, onMuted };

  useEffect(() => { override.current = false; }, [outputDevice]);

  useEffect(() => {
    if (!onSpeakers || !hearingMyself || !takesTrackId || pendingMonitor) return;
    if (override.current || muting.current) return;
    muting.current = true;
    void actions.current.turnOff(takesTrackId).then((done) => {
      if (done) actions.current.onMuted(outputDevice);
    }).finally(() => { muting.current = false; });
  }, [onSpeakers, hearingMyself, takesTrackId, pendingMonitor, outputDevice]);

  return {
    onSpeakers,
    /** The producer chose to hear themselves anyway: stand down until the output changes. */
    markOverride: () => { override.current = true; },
  };
}

/** The guard's note, in the singer's words. */
export function speakerMutedNote(outputDevice: string): string {
  return `Sound is playing through ${outputDevice}, so Hear myself is off. Plug in headphones, then turn it back on.`;
}
