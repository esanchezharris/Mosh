import { useStore } from "../store";
import {
  microphonePermissionStatus, pickFiles, pickSaveFile, requestMicrophonePermission,
} from "../bridge";
import { startVocalProject } from "../menuActions";
import type { CommandResult } from "../types";
import { MIC_COPY } from "./micCheck";
import { trackById, type MicState } from "./startFlow";
import { useStartMemory } from "./startMemory";
import { looksLikeSpeakers, setInputMonitor, type VocalSetupIO } from "./vocalSetup";

// Making the recording song, and the one way the first-run checklist talks to the engine.
// React-free: the launch path (RecordingSetup.tsx) and the checklist's own "New song"
// button run the SAME function, so a friend ends up with the same tracks either way.
// Every edit goes through store.exec; nothing here adds a command.

/** Engine refusals that mean "not now" rather than "broken". */
export function friendlyError(command: string, error: string | undefined): string {
  const e = error ?? `${command} failed`;
  if (/agent transaction .* is open|a batch is already open/i.test(e)) return "Mosh is in the middle of something. Try again in a moment.";
  if (/while recording|recording is in progress/i.test(e)) return "Stop the take first.";
  return e;
}

/** One command, honest about its outcome: a refusal lands in the checklist's note, a
 *  success refreshes the snapshot before the next step reads it. */
export async function startRun(command: string, args: Record<string, unknown> = {}): Promise<CommandResult | null> {
  try {
    const result = await useStore.getState().exec(command, args);
    if (!result.ok) useStartMemory.getState().setNote(friendlyError(command, result.error));
    else await useStore.getState().refresh();
    return result;
  } catch (error) {
    useStartMemory.getState().setNote(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export const startIO: VocalSetupIO = {
  run: startRun,
  query: async (command, args) => useStore.getState().exec(command, args ?? {}),
  snapshot: () => useStore.getState().snapshot,
  setMonitor: async (trackId, mode) => {
    const r = await setInputMonitor(startRun, trackId, mode);
    if (!r.ok && r.reason) useStartMemory.getState().setNote(`Hear myself unchanged: ${r.reason}`);
    return r.ok;
  },
};

/** The checklist's speaker guard lives in RecordingSetup (always mounted); the checklist's
 *  own "Hear myself" button reaches its override through here. */
export const speakerGuard: { markOverride: () => void } = { markOverride: () => undefined };

/** Ask macOS about the mic BEFORE anything arms a track. Re-reads the live status every
 *  time (a timed-out or failed request is asked again). `proceed` is false while macOS is
 *  STILL undecided: the recording template would then raise the prompt synchronously
 *  inside new_project and freeze the app for up to two minutes, so the caller must stop. */
export async function askForMic(known: MicState = "unknown"): Promise<{ status: MicState; proceed: boolean }> {
  let status: MicState = known;
  try {
    if (status !== "granted") status = (await microphonePermissionStatus()).status;
    if (status === "not-determined") {
      useStartMemory.getState().setNote(MIC_COPY.ask);
      status = (await requestMicrophonePermission()).status;
      if (status === "not-determined" || status === "timed-out") {
        // Ask once more: a prompt dismissed by a focus change reads as not answered.
        status = (await microphonePermissionStatus()).status;
      }
    }
  } catch {
    status = "unknown";
  }
  return { status, proceed: status !== "not-determined" };
}

/** A new song from the recording template: Beat, Lead vocal with its Takes lane (armed,
 *  heard live through Tuned Lead) and Ad-libs. Returns true when the song is in place. One at a time. */
export async function createRecordingSong(): Promise<boolean> {
  const memory = useStartMemory.getState();
  if (memory.settingUp) return false;
  memory.setSettingUp(true);
  memory.setNote(null);
  let songError: string | null = null;
  try {
    const mic = await askForMic();
    if (!mic.proceed) { songError = `${MIC_COPY.ask} Then press the button again.`; return false; }
    useStartMemory.getState().setNote(null);
    useStartMemory.getState().reset();
    const made = await startVocalProject({ store: useStore.getState(), pickFiles, pickSaveFile });
    if (!made.ok) { songError = friendlyError("new_project", made.error); return false; }
    const snap = () => useStore.getState().snapshot;
    // An engine that predates the template answers with an empty project: make the two
    // tracks the checklist needs by hand rather than leave the rapper with nothing.
    const ensure = async (id: string, name: string) => {
      if (id && trackById(snap(), id)) return id;
      const found = snap()?.tracks.find((t) => t.name === name)?.id;
      if (found) return found;
      const created = await startRun("create_track", { name, type: "audio" });
      const newId = (created?.data as { trackId?: unknown } | undefined)?.trackId;
      return typeof newId === "string" ? newId : null;
    };
    const beatId = await ensure(made.backingTrackId, "Beat");
    const leadId = await ensure(made.vocalTrackId, "Lead vocal");
    if (!leadId) { songError = "The Lead vocal track couldn't be made."; return false; }
    // No live mic into laptop speakers: the template turns Hear myself on, and on a Mac
    // with nothing plugged in that is a feedback howl the moment the song opens.
    // The mic is heard through the Takes lane the template makes under the Lead (an older
    // engine makes none, and the Lead itself holds the mic).
    const takesId = made.takesTrackId && trackById(snap(), made.takesTrackId) ? made.takesTrackId : null;
    const micId = takesId ?? leadId;
    const output = snap()?.audio?.outputDevice;
    if (looksLikeSpeakers(output) && trackById(snap(), micId)?.monitor !== "off"
      && await startIO.setMonitor(micId, "off")) {
      useStartMemory.getState().setNote("Hear myself is off: plug in headphones first.");
    }
    useStartMemory.getState().patch({
      ids: { backingTrackId: beatId, leadTrackId: leadId, takesTrackId: takesId },
      epoch: useStore.getState().projectEpoch,
    });
    return true;
  } catch (error) {
    songError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    useStartMemory.getState().setSettingUp(false, songError);
  }
}
