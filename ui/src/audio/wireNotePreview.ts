// Binds the notePreview singleton to the live store and the producer's Preview setting.
//
// It lives in its own module, and is called by BOTH the piano roll and the QWERTY keyboard
// hook, because either one alone must be enough. Wiring it in only one of them makes
// audition silently depend on the other feature being mounted — which is exactly how the
// piano roll's audition came out mute the first time: notePreview was configured in
// useQwertyMidi (mounted by AppV2), so a piano roll rendered on its own sent nothing at all.
//
// configure() is idempotent and cheap, so calling it from several places is the point
// rather than a cost. Both dependencies are read at CALL time, so neither costs a re-render
// on a pointermove.

import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { notePreview } from "./notePreview";

export function wireNotePreview(): void {
  notePreview.configure({
    exec: (command, args) => useStore.getState().exec(command, args),
    enabled: () => Boolean(useSettings.getState().get("notePreview")),
  });
}
