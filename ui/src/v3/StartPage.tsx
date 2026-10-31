import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import {
  microphonePermissionStatus, pickFiles, pickSaveFile, requestMicrophonePermission,
  type MicrophonePermissionStatus,
} from "../bridge";
import { startVocalProject } from "../menuActions";
import { projectLabel } from "../projectFile";
import { setFileDropIntercept, looksLikeAudio, toBase64 } from "../hooks/useFileDrop";
import { QrImage } from "../ui/QrImage";
import type { CommandResult, Snapshot } from "../types";
import { useV3 } from "./shellState";
import { MoshiFace } from "./MoshiFace";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import { InputMeter } from "./InputMeter";
import { dropDrumBeat } from "./beats";
import {
  AUTOTUNE_KEYS, PIPS, beatClipOf, beatDone, firstIncomplete, hasOwnChain, pickBackingTrack, pickContinueLead,
  pipStates, readyBlocker, setKeyArgs, songReady, trackById, voicePresetOf,
  type AutoTuneScale, type BeatLocal, type MicState, type PhoneLocal, type StartIds, type StartStep,
} from "./startFlow";
import { MIC_COPY, micFromEngineError, micFromPermission, type MicReport } from "./micCheck";
import {
  AUDIO_FILTERS, DROP_CAP_BYTES, confirmTempo, detectBpm, doubleBpm, formatBpm, halveBpm, importBeat,
  proposeTempo, clampBpm, type BeatSource, type TempoProposal,
} from "./beatImport";
import { CONNECT_HANDOFF_MS, pairingView } from "./phonePairing";
import {
  DEFAULT_VOCAL_CHAIN, TUNED_VOCAL_CHAIN, findPresetFile, setInputMonitor, setupVocalLoop, switchVocalPreset,
  type VocalSetupIO,
} from "./vocalSetup";
import { speakerMutedNote, useSpeakerGuard } from "./useSpeakerGuard";

// The V3 Start page: the friends-first way into Mosh for a novice rapper or singer
// (docs/LAUNCH-PAGE-BRIEF-2026-10-30.md). A POSTURE, not a modal: it replaces the
// workspace, owns the drop target, and hands off to the Booth. It sequences commands the
// singer could run from the Studio; it adds none. Every edit goes through store.exec.

// What the page remembers between visits within one app run (the Booth's "← Start" comes
// back to the same song). Choices only: facts are re-read from the snapshot every render.
interface FlowMemory {
  visited: boolean;
  epoch: number | null;
  ids: StartIds;
  beat: BeatLocal & { fileName: string; proposal: TempoProposal | null; bpmText: string };
  phone: PhoneLocal;
}
const EMPTY_IDS: StartIds = { backingTrackId: null, leadTrackId: null, takesTrackId: null };
const EMPTY_BEAT: FlowMemory["beat"] = { clipId: null, confirmed: false, skipped: false, fileName: "", proposal: null, bpmText: "" };
const EMPTY_PHONE: PhoneLocal = { everConnected: false, skipped: false };

export const useStartMemory = create<FlowMemory & { patch: (p: Partial<FlowMemory>) => void; reset: () => void }>((set) => ({
  visited: false, epoch: null, ids: EMPTY_IDS, beat: EMPTY_BEAT, phone: EMPTY_PHONE,
  patch: (p) => set(p),
  reset: () => set({ epoch: null, ids: EMPTY_IDS, beat: EMPTY_BEAT, phone: EMPTY_PHONE }),
}));

/** Engine refusals that mean "not now" rather than "broken". */
function friendlyError(command: string, error: string | undefined): string {
  const e = error ?? `${command} failed`;
  if (/agent transaction .* is open|a batch is already open/i.test(e)) return "Moshi is in the middle of something. Try again in a moment.";
  if (/while recording|recording is in progress/i.test(e)) return "Stop the take first.";
  return e;
}

const KEY_LOOSE = "loose";

/** Re-entry's view of the voice step: ready from the snapshot alone (the mic permission is
 *  re-read on the Voice step itself, so "unknown" here never blocks). */
function voiceReadyNow(snap: Snapshot | null | undefined, ids: StartIds): boolean {
  const lead = trackById(snap, ids.leadTrackId);
  return readyBlocker({ snapshot: snap, ids, mic: "unknown", chainNotRequired: hasOwnChain(lead) && voicePresetOf(lead) === "none" }) === null;
}

export function StartPage({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const projectEpoch = useStore((s) => s.projectEpoch);
  const transitioning = useStore((s) => s.projectTransitioning);
  const mpActive = useStore((s) => s.mp.active);
  const remote = useStore((s) => s.remoteStatus);
  const lastError = useStore((s) => s.lastError);
  const celebrateTick = useStore((s) => s.celebrateTick);
  const peaks = useStore((s) => s.peaks);
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const setPosture = useV3((s) => s.setPosture);
  const setSettingsOpen = useV3((s) => s.setSettingsOpen);
  const showOnLaunch = useSettings((s) => s.get("startOnLaunch")) === true;

  const memory = useStartMemory();
  const { ids, beat, phone } = memory;
  const patchBeat = (p: Partial<FlowMemory["beat"]>) => useStartMemory.setState((m) => ({ beat: { ...m.beat, ...p } }));
  const patchPhone = (p: Partial<PhoneLocal>) => useStartMemory.setState((m) => ({ phone: { ...m.phone, ...p } }));

  const [step, setStep] = useState<StartStep>("welcome");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [songError, setSongError] = useState<string | null>(null);
  const [mic, setMic] = useState<MicState>("unknown");
  const [micReport, setMicReport] = useState<MicReport | null>(null);
  const [dragging, setDragging] = useState(false);
  const [presets, setPresets] = useState<{ clean?: string; tuned?: string } | null>(null);
  const [tunedOpen, setTunedOpen] = useState(false);
  const [keyLabel, setKeyLabel] = useState<string>(KEY_LOOSE);
  const [scale, setScale] = useState<AutoTuneScale>("Major");
  const [previewing, setPreviewing] = useState(false);
  const [pairRequested, setPairRequested] = useState(false);
  const [pairShownAt, setPairShownAt] = useState<number | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const ownTransition = useRef(false);
  const metronomeBefore = useRef<boolean | null>(null);

  const recording = !!snapshot.transport?.recording;
  const lead = trackById(snapshot, ids.leadTrackId);
  const takes = trackById(snapshot, ids.takesTrackId);
  const hearingMyself = takes ? takes.monitor !== "off" : false;
  const outputDevice = snapshot.audio?.outputDevice ?? "";
  const leadOwnChain = hasOwnChain(lead) && voicePresetOf(lead) === "none";
  const chainNotRequired = (presets !== null && !presets.clean) || leadOwnChain;
  const blocker = readyBlocker({ snapshot, ids, mic, chainNotRequired });
  const voiceReady = blocker === null;
  const disabledAll = busy || transitioning || recording;

  // ── one command, honest about its outcome (the Booth's `run`, with friendlier words) ──
  const run = useCallback(async (command: string, args: Record<string, unknown> = {}): Promise<CommandResult | null> => {
    try {
      const result = await exec(command, args);
      if (!result.ok) setNote(friendlyError(command, result.error));
      else await useStore.getState().refresh();
      return result;
    } catch (error) {
      setNote(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, [exec]);
  const busyWhile = async <T,>(work: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try { return await work(); } finally { setBusy(false); }
  };
  const io: VocalSetupIO = {
    run,
    query: async (command, args) => exec(command, args ?? {}),
    snapshot: () => useStore.getState().snapshot,
    setMonitor: async (trackId, mode) => {
      const r = await setInputMonitor(run, trackId, mode);
      if (!r.ok && r.reason) setNote(`Monitoring unchanged: ${r.reason}`);
      return r.ok;
    },
  };

  // ── arrival: Welcome the first time in a run, otherwise where the song actually is ──
  useEffect(() => {
    const m = useStartMemory.getState();
    const snap = useStore.getState().snapshot;
    let nextIds = m.ids;
    if (m.epoch !== null && m.epoch !== useStore.getState().projectEpoch) {
      m.reset();
      nextIds = EMPTY_IDS;
    }
    if (!songReady(snap, nextIds) && snap?.loop?.engaged) {
      // Continue mode on a song the Booth already set up: adopt its Lead and Takes.
      nextIds = {
        leadTrackId: snap.loop.leadTrackId ?? null,
        takesTrackId: snap.loop.takesTrackId ?? null,
        backingTrackId: pickBackingTrack(snap.tracks, snap.loop)?.id ?? null,
      };
      useStartMemory.getState().patch({ ids: nextIds, epoch: useStore.getState().projectEpoch });
    }
    if (m.visited) {
      const b = useStartMemory.getState().beat;
      setStep(firstIncomplete(snap, nextIds, b, voiceReadyNow(snap, nextIds)));
    }
    useStartMemory.getState().patch({ visited: true });
    void microphonePermissionStatus().then((r) => setMic(r.status)).catch(() => setMic("unknown"));
  }, []);

  // ── someone else replaced the project (⌘N, Open, a multiplayer join) ──
  useEffect(() => {
    const m = useStartMemory.getState();
    if (m.epoch === null || ownTransition.current || transitioning) return;
    if (projectEpoch !== m.epoch) {
      m.reset();
      setStep("welcome");
      setNote("The song changed. Start again, or continue with what's open.");
    }
  }, [projectEpoch, transitioning]);

  // ── the speaker guard, the same one the Booth runs ──
  const { onSpeakers, markOverride } = useSpeakerGuard({
    outputDevice,
    hearingMyself,
    takesTrackId: takes?.id,
    pendingMonitor: false,
    turnOff: (id) => io.setMonitor(id, "off"),
    onMuted: (device) => setNote(speakerMutedNote(device)),
  });

  // ── Welcome → Song ──────────────────────────────────────────────────────────────────
  const ensureMicAsked = async (): Promise<MicrophonePermissionStatus | "unknown"> => {
    let status: MicrophonePermissionStatus | "unknown" = mic;
    try {
      if (status === "unknown") status = (await microphonePermissionStatus()).status;
      if (status === "not-determined") {
        setNote(MIC_COPY.ask);
        status = (await requestMicrophonePermission()).status;
      }
    } catch {
      status = "unknown";
    }
    setMic(status);
    return status;
  };

  const finishSong = async (backingId: string | null, leadId: string, alreadyEngaged: boolean) => {
    let takesId = alreadyEngaged ? (useStore.getState().snapshot?.loop?.takesTrackId ?? null) : null;
    if (!alreadyEngaged) {
      const setup = await setupVocalLoop(io, leadId, useStore.getState().snapshot ?? snapshot);
      if (!setup.setup?.ok || !setup.takesId) {
        setSongError(friendlyError("loop_setup", setup.setup?.error ?? "The Booth couldn't be set up"));
        return false;
      }
      takesId = setup.takesId;
      if (setup.armed === false) setMicReport(micFromEngineError("No audio input device is available"));
      setNote(setup.notes.length > 0 ? setup.notes.join(" · ") : null);
    }
    useStartMemory.getState().patch({
      ids: { backingTrackId: backingId, leadTrackId: leadId, takesTrackId: takesId },
      epoch: useStore.getState().projectEpoch,
    });
    return true;
  };

  const startNewSong = () => busyWhile(async () => {
    setSongError(null);
    await ensureMicAsked();
    setStep("song");
    ownTransition.current = true;
    try {
      useStartMemory.getState().reset();
      const made = await startVocalProject({ store: useStore.getState(), pickFiles, pickSaveFile });
      if (!made.ok) { setSongError(friendlyError("new_project", made.error)); return; }
      const snap = () => useStore.getState().snapshot;
      const byName = (name: string) => snap()?.tracks.find((t) => t.name === name)?.id ?? null;
      const ensure = async (id: string, name: string) => {
        if (id && trackById(snap(), id)) return id;
        const found = byName(name);
        if (found) return found;
        const created = await run("create_track", { name, type: "audio" });
        const newId = (created?.data as { trackId?: unknown } | undefined)?.trackId;
        return typeof newId === "string" ? newId : null;
      };
      const backingId = await ensure(made.backingTrackId, "Backing");
      const vocalId = await ensure(made.vocalTrackId, "Vocal");
      if (!vocalId) { setSongError("The Vocal track couldn't be made."); return; }
      if (await finishSong(backingId, vocalId, false)) setStep("beat");
    } finally {
      ownTransition.current = false;
    }
  });

  const continueSong = () => busyWhile(async () => {
    setSongError(null);
    await ensureMicAsked();
    const snap = useStore.getState().snapshot ?? snapshot;
    let leadTrack = pickContinueLead(snap, useStore.getState().selectedTrackId);
    if (!leadTrack) {
      const created = await run("create_track", { name: "Vocal", type: "audio" });
      const id = (created?.data as { trackId?: unknown } | undefined)?.trackId;
      leadTrack = typeof id === "string" ? trackById(useStore.getState().snapshot, id) : undefined;
      if (!leadTrack) { setSongError("The Vocal track couldn't be made."); return; }
    }
    const engaged = !!snap.loop?.engaged && snap.loop.leadTrackId === leadTrack.id;
    const backing = pickBackingTrack(snap.tracks, snap.loop);
    if (!(await finishSong(backing?.id ?? null, leadTrack.id, engaged))) { setStep("song"); return; }
    const m = useStartMemory.getState();
    const existingBeat = beatClipOf(useStore.getState().snapshot, m.ids, m.beat);
    if (existingBeat) patchBeat({ confirmed: true, bpmText: formatBpm(Math.round(useStore.getState().snapshot?.session.tempo ?? 120)) });
    const after = useStore.getState().snapshot;
    const next = firstIncomplete(after, useStartMemory.getState().ids, useStartMemory.getState().beat,
      voiceReadyNow(after, useStartMemory.getState().ids));
    setStep(next === "welcome" ? "beat" : next);
  });

  // ── Beat ──────────────────────────────────────────────────────────────────────────
  const beatClip = beatClipOf(snapshot, ids, beat);
  useEffect(() => { if (beatClip?.id) ensurePeaks(beatClip.id); }, [beatClip?.id, ensurePeaks]);

  const ensureBacking = async (): Promise<string | null> => {
    const m = useStartMemory.getState();
    const fresh = useStore.getState().snapshot;
    if (m.ids.backingTrackId && trackById(fresh, m.ids.backingTrackId)) return m.ids.backingTrackId;
    const found = fresh ? pickBackingTrack(fresh.tracks, fresh.loop) : undefined;
    let id = found?.id ?? null;
    if (!id) {
      const created = await run("create_track", { name: "Backing", type: "audio" });
      const newId = (created?.data as { trackId?: unknown } | undefined)?.trackId;
      id = typeof newId === "string" ? newId : null;
    }
    if (id) useStartMemory.getState().patch({ ids: { ...useStartMemory.getState().ids, backingTrackId: id } });
    return id;
  };

  const addBeat = (source: BeatSource, fileName: string) => busyWhile(async () => {
    setNote(null);
    const backingId = await ensureBacking();
    if (!backingId) { setNote("The Backing track couldn't be made."); return; }
    const previous = useStartMemory.getState().beat.clipId;
    const added = await importBeat(run, source, backingId, previous && trackById(useStore.getState().snapshot, backingId)?.clips.some((c) => c.id === previous) ? previous : null);
    if (!added.ok || !added.clipId) { setNote(added.error ? `Couldn't add that beat: ${added.error}` : "Couldn't add that beat."); return; }
    await useStore.getState().refresh();
    const detected = await detectBpm(run, added.clipId);
    const proposal = proposeTempo(detected, fileName, useStore.getState().snapshot?.session.tempo ?? 120);
    patchBeat({ clipId: added.clipId, fileName, proposal, bpmText: formatBpm(proposal.bpm), confirmed: false, skipped: false });
    if (!detected) setNote(null);
  });

  const chooseBeat = async () => {
    const picked = await pickFiles({ title: "Choose a beat", filters: AUDIO_FILTERS });
    const file = picked.ok ? picked.files[0] : undefined;
    if (file) await addBeat({ kind: "path", file }, file.split("/").pop() ?? file);
  };

  const dropBeat = useCallback((files: File[]) => {
    setDragging(false);
    const audio = files.find((f) => looksLikeAudio(f));
    if (!audio) { setNote("That isn't an audio file. Mosh takes .wav, .mp3, .aiff, .flac or .ogg."); return; }
    if (audio.size > DROP_CAP_BYTES) { setNote("That's a big file. Use Choose a file… instead."); return; }
    void (async () => {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      await addBeat({ kind: "data", name: audio.name, dataBase64: toBase64(bytes) }, audio.name);
    })();
    // addBeat is stable enough for a drop: it reads everything it needs from the stores.
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // The Beat step owns drops; elsewhere on the page a drop is ignored (not imported onto
  // whichever track happens to be selected).
  useEffect(() => {
    const clear = setFileDropIntercept(step === "beat" && !recording ? dropBeat : () => {
      setNote(step === "beat" ? "Stop the take first." : "Drop your beat on the Beat step.");
    });
    const enter = (e: DragEvent) => { if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) setDragging(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", leave);
    return () => {
      clear();
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", leave);
    };
  }, [step, recording, dropBeat]);

  const bpmValue = clampBpm(Number(beat.bpmText));
  const setBpm = (bpm: number) => patchBeat({ bpmText: formatBpm(clampBpm(bpm)), confirmed: false });

  const stopPreview = async () => {
    if (!previewing && metronomeBefore.current === null) return;
    setPreviewing(false);
    await run("set_transport", { action: "stop" });
    if (metronomeBefore.current !== null) {
      await run("set_metronome", { enabled: metronomeBefore.current });
      metronomeBefore.current = null;
    }
  };
  const togglePreview = () => busyWhile(async () => {
    if (previewing) { await stopPreview(); return; }
    if (!beatClip) return;
    metronomeBefore.current = !!useStore.getState().snapshot?.session.metronome;
    await run("set_tempo", { bpm: bpmValue });
    await run("set_transport", { loop: true, loopStart: beatClip.start, loopEnd: beatClip.start + beatClip.length });
    await run("set_metronome", { enabled: true });
    await run("set_transport", { action: "play", position: beatClip.start });
    setPreviewing(true);
  });

  const useTempo = () => busyWhile(async () => {
    if (!beatClip) return;
    await stopPreview();
    const error = await confirmTempo(run, bpmValue, beatClip);
    if (error) { setNote(friendlyError("set_tempo", error)); return; }
    patchBeat({ confirmed: true });
    await run("set_transport", { action: "play", position: beatClip.start });
  });

  const useDrumBeat = () => busyWhile(async () => {
    const dropped = await dropDrumBeat();
    if (!dropped) setNote(useStore.getState().lastError ?? "The drum beat couldn't be added.");
    else patchBeat({ confirmed: true, skipped: false });
  });

  const leaveBeat = (next: StartStep) => busyWhile(async () => {
    await stopPreview();
    if (useStore.getState().transport.playing) await run("set_transport", { action: "stop" });
    setStep(next);
  });

  // ── Voice ─────────────────────────────────────────────────────────────────────────
  const checkMic = useCallback(async () => {
    let status: MicState = "unknown";
    try {
      status = (await microphonePermissionStatus()).status;
      if (status === "not-determined") status = (await requestMicrophonePermission()).status;
    } catch { status = "unknown"; }
    setMic(status);
    const fromPermission = micFromPermission(status);
    if (fromPermission.problem !== "ok" && fromPermission.problem !== "ask") { setMicReport(fromPermission); return; }
    const m = useStartMemory.getState();
    const lane = trackById(useStore.getState().snapshot, m.ids.takesTrackId);
    if (!lane) return;
    if (lane.armed) { setMicReport(null); return; }
    const probe = await exec("arm_track", { trackId: lane.id, armed: true }).catch(() => null);
    if (!probe) { setMicReport(micFromEngineError("The microphone didn't answer")); return; }
    if (!probe.ok) { setMicReport(micFromEngineError(probe.error)); return; }
    const data = probe.data as { applied?: unknown; reason?: unknown } | undefined;
    setMicReport(data?.applied === false ? micFromEngineError(typeof data.reason === "string" ? data.reason : "no input device") : null);
    await useStore.getState().refresh();
  }, [exec]);

  useEffect(() => {
    if (step !== "voice") return;
    void checkMic();
    void (async () => {
      const [clean, tuned] = await Promise.all([findPresetFile(io, DEFAULT_VOCAL_CHAIN), findPresetFile(io, TUNED_VOCAL_CHAIN)]);
      setPresets({ clean, tuned });
    })();
  }, [step]);   // eslint-disable-line react-hooks/exhaustive-deps

  const retryMic = () => busyWhile(async () => {
    if (micReport?.audioSettings) await run("retry_audio_device", {});
    await checkMic();
  });

  const switchVoice = (to: "clean" | "tuned") => busyWhile(async () => {
    if (!ids.leadTrackId || !ids.takesTrackId) return;
    const key = to === "tuned" && keyLabel !== KEY_LOOSE
      ? { keyLabel, scale } : to === "tuned" ? { keyLabel: "C", scale: "Chromatic" as const } : undefined;
    const r = await switchVocalPreset(io, { leadId: ids.leadTrackId, takesId: ids.takesTrackId, to, key });
    if (!r.ok) { setNote(r.error); return; }
    const keyArgs = key ? setKeyArgs(key.keyLabel, key.scale) : null;
    if (keyArgs) await run("set_key", keyArgs);
    setNote(to === "tuned" ? "Tuned Lead is on your voice." : "Clean Lead is on your voice.");
    if (to === "tuned") setTunedOpen(false);
  });

  const toggleHearMyself = () => busyWhile(async () => {
    if (!takes) return;
    const target = hearingMyself ? "off" : "automatic";
    if (target === "automatic" && onSpeakers) markOverride();
    await io.setMonitor(takes.id, target);
  });

  const goReady = () => {
    setStep("ready");
    useStore.getState().bumpCelebrate();
  };

  const goBooth = () => busyWhile(async () => {
    if (useStore.getState().transport.playing && !recording) await run("set_transport", { action: "stop" });
    useStore.getState().setView("arrange");
    setPosture("booth");
  });

  // ── Phone ─────────────────────────────────────────────────────────────────────────
  const pairing = remote?.pairing ?? null;
  const phoneConnected = snapshot.loop?.phoneConnected === true;
  useEffect(() => { if (phoneConnected && !phone.everConnected) patchPhone({ everConnected: true }); }, [phoneConnected]);   // eslint-disable-line react-hooks/exhaustive-deps
  const view = pairingView({ requested: pairRequested || !!pairing, pairing, error: pairError,
    everConnected: phone.everConnected, shownAtMs: pairShownAt, nowMs: now });

  useEffect(() => {
    if (step !== "phone" || view.phase === "connected" || view.phase === "idle") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [step, view.phase]);
  useEffect(() => {
    if (step === "phone" && view.phase === "expired") void useStore.getState().refreshRemote();
  }, [step, view.phase]);
  useEffect(() => {
    if (step !== "phone" || view.phase !== "connected") return;
    const id = window.setTimeout(() => { void goBooth(); }, CONNECT_HANDOFF_MS);
    return () => window.clearTimeout(id);
  }, [step, view.phase]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pairRequested && !pairing && lastError && /remote companion|phone/i.test(lastError)) setPairError(lastError);
  }, [lastError, pairRequested, pairing]);
  // The phone's start error lives in the app's ONE error slot: leave it behind with the step.
  useEffect(() => () => { if (pairError) useStore.getState().setLastError(null); }, [step]);   // eslint-disable-line react-hooks/exhaustive-deps

  const showCode = () => busyWhile(async () => {
    useStore.getState().setLastError(null);
    setPairError(null);
    setPairRequested(true);
    setPairShownAt(Date.now());
    setNow(Date.now());
    await useStore.getState().startRemotePairing();
    const after = useStore.getState();
    if (!after.remoteStatus?.pairing && after.lastError) setPairError(after.lastError);
  });

  // ── layout ────────────────────────────────────────────────────────────────────────
  const pips = pipStates({ step, snapshot, ids, beat, phone, voiceReady });
  const leadPreset = voicePresetOf(lead);
  const needsFix = leadPreset === "lost-tuner" || leadPreset === "stacked" || leadPreset === "mixed"
    || (voicePresetOf(takes) !== leadPreset && (leadPreset === "clean" || leadPreset === "tuned"));
  const loopBlock = snapshot.loop?.blockReason ?? "";
  const continueLabel = projectLabel(snapshot.session.editFile) || "your last song";
  const keptCount = (snapshot.loop?.contributions ?? []).filter((p) => p.keeper).length;
  const moodBusy = busy || transitioning;

  return (
    <div className="start-stage" data-testid="v3-start" data-step={step}>
      <div className="start-col">
        <div className="start-head">
          <MoshiFace celebrateTick={step === "ready" ? celebrateTick : 0} mood={{ safe: false, busy: moodBusy, listening: false, clarify: false }} />
          <ol className="start-rail" data-testid="v3-start-progress" aria-label="Steps">
            {PIPS.map((pip) => (
              <li key={pip.key} className={`pip ${pips[pip.key]}`} data-testid={`v3-start-pip-${pip.key}`} data-state={pips[pip.key]}
                aria-current={pips[pip.key] === "current" ? "step" : undefined}>
                <span className="dot" aria-hidden="true">{pips[pip.key] === "done" ? "✓" : ""}</span>
                <span>{pip.label}{pip.key === "phone" ? " (optional)" : ""}</span>
              </li>
            ))}
          </ol>
          {step !== "welcome" && step !== "song" && (
            <button type="button" className="btn ghost sm" data-testid="v3-start-over" disabled={disabledAll}
              onClick={() => { setStep("welcome"); setNote(null); }}>New song</button>
          )}
        </div>

        {transitioning && <div className="set-hint" role="status">Opening…</div>}

        {step === "welcome" && (
          <section className="start-card" data-testid="v3-start-welcome">
            <h2 className="start-title">Record yourself. Fast.</h2>
            <p className="set-hint">Mosh sets up the room for you: your beat, your voice, and a loop that keeps every take.</p>
            <p className="set-hint">Put your headphones on first. {mic === "not-determined" ? MIC_COPY.ask : ""}</p>
            <div className="start-actions">
              <button type="button" className="btn pri" data-testid="v3-start-new" disabled={disabledAll || mpActive}
                title={mpActive ? "This guided start is for a solo session" : undefined}
                onClick={() => void startNewSong()}>Start a new song</button>
              {snapshot.tracks.length > 0 && (
                <button type="button" className="btn" data-testid="v3-start-continue" disabled={disabledAll}
                  onClick={() => void continueSong()}>Continue {continueLabel}</button>
              )}
            </div>
            {mpActive && <p className="set-hint">This guided start is for a solo session. Continue, or open the studio.</p>}
            {snapshot.tracks.length > 0 && (
              <p className="set-hint" data-testid="v3-start-continue-summary">
                {snapshot.tracks.length} tracks · {keptCount} {keptCount === 1 ? "take" : "takes"} kept
                {(() => {
                  const missing = snapshot.tracks.reduce((n, t) => n + t.clips.filter((c) => (c as { sourceMissing?: boolean }).sourceMissing && !(c as { hidden?: boolean }).hidden).length, 0);
                  return missing > 0 ? ` · ${missing} ${missing === 1 ? "clip is" : "clips are"} missing audio; relink in the studio` : "";
                })()}
              </p>
            )}
          </section>
        )}

        {step === "song" && (
          <section className="start-card" data-testid="v3-start-song">
            <h2 className="start-title">{songError ? "Couldn't finish setting up the song" : "Setting up your song…"}</h2>
            {songError ? (
              <>
                <p className="set-hint" role="alert" data-testid="v3-start-song-error">{songError}</p>
                <div className="start-actions">
                  <button type="button" className="btn pri" disabled={disabledAll} onClick={() => void startNewSong()}>Try again</button>
                  <button type="button" className="btn" onClick={() => setPosture("studio")}>Open the studio</button>
                </div>
              </>
            ) : (
              <p className="set-hint">A Backing track for your beat, a Vocal track for you, and a Takes lane that keeps every pass.</p>
            )}
          </section>
        )}

        {step === "beat" && (
          <section className="start-card" data-testid="v3-start-beat">
            <h2 className="start-title">Drop in your beat</h2>
            <div className={`start-drop${dragging ? " armed" : ""}`} data-testid="v3-start-drop" data-armed={dragging ? true : undefined}>
              {beatClip ? (
                <div className="start-beat-wave">
                  <SilhouetteWave peaks={peaks[beatClip.id]} selected className="cwave" />
                  <span className="set-hint">{beat.fileName || beatClip.name}</span>
                </div>
              ) : (
                <span>Drag a .wav, .mp3 or .aiff here</span>
              )}
            </div>
            <div className="start-actions">
              <button type="button" className={`btn${beatClip ? "" : " pri"}`} data-testid="v3-start-choose" disabled={disabledAll}
                onClick={() => void chooseBeat()}>{beatClip ? "Choose a different beat…" : "Choose a file…"}</button>
              {!beatClip && (
                <button type="button" className="btn ghost" data-testid="v3-start-drum-beat" disabled={disabledAll}
                  onClick={() => void useDrumBeat()}>No beat? Use a drum beat</button>
              )}
              {!beatDone(snapshot, ids, beat) && (
                <button type="button" className="btn ghost" data-testid="v3-start-skip-beat" disabled={disabledAll}
                  onClick={() => { patchBeat({ skipped: true }); void leaveBeat("voice"); }}>Skip for now</button>
              )}
            </div>

            {beatClip && (
              <div className="start-tempo" data-testid="v3-start-tempo">
                <p className="start-lead" data-testid="v3-start-tempo-line">
                  {beat.confirmed
                    ? <>Your beat is at <b>{formatBpm(bpmValue)}</b> BPM.</>
                    : beat.proposal === null
                      ? <>Still <b>{beat.bpmText || formatBpm(Math.round(snapshot.session.tempo ?? 120))}</b> BPM?</>
                      : beat.proposal.source === "session"
                        ? <>Couldn't hear the tempo. Type it; it's often in the file name.</>
                        : beat.proposal.sure
                          ? <>Sounds like <b>{formatBpm(beat.proposal.bpm)}</b> BPM.</>
                          : <>Not sure. Sounds like <b>{formatBpm(beat.proposal.bpm)}</b> BPM?</>}
                </p>
                <div className="start-actions">
                  <label className="set-hint start-bpm">
                    BPM
                    <input className="field" type="number" min={40} max={240} step={1} data-testid="v3-start-bpm"
                      value={beat.bpmText} disabled={disabledAll}
                      onChange={(e) => patchBeat({ bpmText: e.target.value, confirmed: false })} />
                  </label>
                  <button type="button" className="btn sm" data-testid="v3-start-bpm-half" disabled={disabledAll}
                    onClick={() => setBpm(halveBpm(bpmValue))}>÷2</button>
                  <button type="button" className="btn sm" data-testid="v3-start-bpm-double" disabled={disabledAll}
                    onClick={() => setBpm(doubleBpm(bpmValue))}>×2</button>
                  <button type="button" className={`btn sm${previewing ? " on" : ""}`} data-testid="v3-start-preview"
                    aria-pressed={previewing} disabled={disabledAll && !previewing}
                    onClick={() => void togglePreview()}>{previewing ? "■ Stop" : "▶ Hear it with the click"}</button>
                </div>
                <div className="start-actions">
                  {!beat.confirmed ? (
                    <button type="button" className="btn pri" data-testid="v3-start-bpm-confirm" disabled={disabledAll}
                      onClick={() => void useTempo()}>Use {formatBpm(bpmValue)} BPM</button>
                  ) : (
                    <button type="button" className="btn pri" data-testid="v3-start-beat-next" disabled={disabledAll}
                      onClick={() => void leaveBeat("voice")}>Next: your voice</button>
                  )}
                </div>
                <p className="set-hint">If the click drifts from the beat, try ÷2 or ×2.</p>
              </div>
            )}
            {!beatClip && beatDone(snapshot, ids, beat) && (
              <div className="start-actions">
                <button type="button" className="btn pri" data-testid="v3-start-beat-next" disabled={disabledAll}
                  onClick={() => void leaveBeat("voice")}>Next: your voice</button>
              </div>
            )}
          </section>
        )}

        {step === "voice" && (
          <section className="start-card" data-testid="v3-start-voice">
            <h2 className="start-title">Your voice</h2>
            {leadOwnChain ? (
              <p className="set-hint" data-testid="v3-start-own-chain">Keeping your own chain. Change it in the studio.</p>
            ) : presets !== null && !presets.clean ? (
              <p className="set-hint">Plain voice: this build has no vocal presets.</p>
            ) : (
              <div className="start-presets" role="radiogroup" aria-label="Vocal sound">
                <button type="button" role="radio" aria-checked={leadPreset === "clean"} data-testid="v3-start-clean"
                  className={`start-preset${leadPreset === "clean" ? " sel" : ""}`} disabled={disabledAll}
                  onClick={() => { if (leadPreset !== "clean") void switchVoice("clean"); }}>
                  <b>Clean Lead</b>
                  <span className="set-hint">Your voice, cleaned up and evened out. A record-ready start.</span>
                </button>
                {presets?.tuned && (
                  <button type="button" role="radio" aria-checked={leadPreset === "tuned"} data-testid="v3-start-tuned"
                    className={`start-preset${leadPreset === "tuned" ? " sel" : ""}`} disabled={disabledAll}
                    onClick={() => setTunedOpen(true)}>
                    <b>Tuned Lead</b>
                    <span className="set-hint">The same, plus pitch correction that snaps you to the key.</span>
                  </button>
                )}
              </div>
            )}
            {tunedOpen && (
              <div className="start-key" data-testid="v3-start-key">
                <label className="set-hint">Key
                  <select className="field" data-testid="v3-start-key-root" value={keyLabel} disabled={disabledAll}
                    onChange={(e) => setKeyLabel(e.target.value)}>
                    <option value={KEY_LOOSE}>I don't know, keep it loose</option>
                    {AUTOTUNE_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </label>
                {keyLabel !== KEY_LOOSE && (
                  <label className="set-hint">Scale
                    <select className="field" data-testid="v3-start-key-scale" value={scale} disabled={disabledAll}
                      onChange={(e) => setScale(e.target.value as AutoTuneScale)}>
                      <option value="Major">Major</option>
                      <option value="Minor">Minor</option>
                    </select>
                  </label>
                )}
                <button type="button" className="btn pri sm" data-testid="v3-start-tuned-apply" disabled={disabledAll}
                  onClick={() => void switchVoice("tuned")}>{leadPreset === "tuned" ? "Update the key" : "Use Tuned Lead"}</button>
                <button type="button" className="btn ghost sm" onClick={() => setTunedOpen(false)}>Cancel</button>
              </div>
            )}
            {needsFix && !leadOwnChain && (
              <div className="start-warn" role="alert" data-testid="v3-start-fix-chain">
                Your vocal chain needs a quick fix after Mosh restarted.
                <button type="button" className="btn sm" disabled={disabledAll}
                  onClick={() => void switchVoice(leadPreset === "clean" ? "clean" : "tuned")}>Fix it</button>
              </div>
            )}

            <div className="start-room" data-testid="v3-start-room">
              <span className="sec">Room check</span>
              <div className={`start-row${micReport && micReport.problem !== "ok" ? " warn" : ""}`} data-testid="v3-start-mic">
                <b>Microphone</b>
                <span className="set-hint">{micReport && micReport.problem !== "ok" ? micReport.text : (snapshot.audio?.inputDevice || "Ready")}</span>
                {micReport?.audioSettings && (
                  <button type="button" className="btn sm" data-testid="v3-start-audio-settings" onClick={() => setSettingsOpen(true)}>Audio settings</button>
                )}
                {micReport?.retry && (
                  <button type="button" className="btn sm" data-testid="v3-start-mic-retry" disabled={disabledAll} onClick={() => void retryMic()}>Retry</button>
                )}
              </div>
              <div className={`start-row${onSpeakers ? " warn" : ""}`} data-testid="v3-start-headphones">
                <b>Headphones</b>
                <span className="set-hint">
                  {onSpeakers
                    ? `Sound is coming out of ${outputDevice}. Plug in headphones so the mic doesn't hear the beat. Hear myself stays off until you do.`
                    : outputDevice || "Ready"}
                </span>
              </div>
              <div className="start-row">
                <button type="button" className={`btn sm${hearingMyself ? " on" : ""}`} data-testid="v3-start-monitor"
                  aria-pressed={hearingMyself} disabled={!takes || disabledAll} onClick={() => void toggleHearMyself()}>
                  Hear myself: {hearingMyself ? "On" : "Off"}
                </button>
                <InputMeter trackId={takes?.id} monitoring={hearingMyself} />
              </div>
              {loopBlock && <p className="set-hint" role="alert">{loopBlock}</p>}
            </div>

            <div className="start-actions">
              <button type="button" className="btn pri" data-testid="v3-start-ready" disabled={!voiceReady || disabledAll}
                onClick={goReady}>{voiceReady ? "I'm ready" : blocker}</button>
              <button type="button" className="btn ghost sm" data-testid="v3-start-go-anyway" disabled={busy}
                onClick={() => void goBooth()}>Go to the Booth anyway</button>
            </div>
          </section>
        )}

        {step === "ready" && (
          <section className="start-card start-ready" data-testid="v3-start-ready-card">
            <h2 className="start-title">You're set.</h2>
            <p className="start-lead">Put Me In when you're ready. Every pass is kept: Keep the good ones, Again for another try.</p>
            <div className="start-actions">
              <button type="button" className="btn pri" data-testid="v3-start-go-booth" disabled={busy}
                onClick={() => void goBooth()}>Go to the Booth</button>
              <button type="button" className="btn" data-testid="v3-start-add-phone" disabled={busy}
                onClick={() => setStep("phone")}>Add your phone (optional)</button>
            </div>
          </section>
        )}

        {step === "phone" && (
          <section className="start-card" data-testid="v3-start-phone">
            <h2 className="start-title">Your phone as a remote</h2>
            {!songReady(snapshot, ids) ? (
              <>
                <p className="set-hint">Set up the song first, so the phone has something to control.</p>
                <button type="button" className="btn" onClick={() => setStep("welcome")}>Set up the song</button>
              </>
            ) : (
              <>
                <p className="set-hint">Record, keep and redo from across the room. Your phone and this Mac need the same Wi-Fi.
                  If your Mac asks whether Mosh can accept network connections, choose Allow.</p>
                {view.phase === "idle" && (
                  <button type="button" className="btn pri" data-testid="v3-start-show-code" disabled={busy}
                    onClick={() => void showCode()}>Show the code</button>
                )}
                {view.phase === "starting" && <p className="set-hint" role="status">Starting the phone link…</p>}
                {view.phase === "failed" && (
                  <div className="start-warn" role="alert" data-testid="v3-start-pair-failed">
                    Couldn't start the phone link: {pairError}. You can skip this; the Booth's pads do everything the phone does.
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void showCode()}>Try again</button>
                  </div>
                )}
                {(view.phase === "showing" || view.phase === "expired") && pairing && (
                  <div className={`start-qr${view.phase === "expired" ? " expired" : ""}`}>
                    <QrImage url={pairing.padUrl} className="phone-qr" waitClassName="phone-qr-wait"
                      alt="Moshi phone pad pairing QR" testId="v3-start-qr" />
                    <div className="start-qr-side">
                      <p className="set-hint">Scan with the iPhone Camera. It opens in Safari, nothing to install.</p>
                      <div className="phone-url" data-testid="v3-start-pad-url">{pairing.padUrl}</div>
                      {view.phase === "expired" ? (
                        <p className="set-hint warn" data-testid="v3-start-pair-expired">This code expired.</p>
                      ) : view.countdown && (
                        <p className={`set-hint${view.warn ? " warn" : ""}`} data-testid="v3-start-pair-ttl">Code valid for {view.countdown}</p>
                      )}
                      {view.canRemint && (
                        <button type="button" className="btn sm" data-testid="v3-start-new-code" disabled={busy}
                          onClick={() => void showCode()}>New code</button>
                      )}
                    </div>
                  </div>
                )}
                {view.stalled && view.phase !== "connected" && (
                  <p className="set-hint" data-testid="v3-start-pair-help">
                    Phone not here yet? Both need the same Wi-Fi, and any VPN on the Mac or phone should be paused.
                    {pairing ? ` This Mac's address is ${pairing.host}; you can type the address above into Safari.` : ""}
                  </p>
                )}
                {view.phase === "connected" && (
                  <p className="start-lead" role="status" data-testid="v3-start-phone-connected">Phone connected. Heading to the Booth…</p>
                )}
              </>
            )}
            <div className="start-actions">
              <button type="button" className="btn ghost" data-testid="v3-start-skip-phone" disabled={busy}
                onClick={() => { patchPhone({ skipped: true }); void goBooth(); }}>Skip, use the keyboard</button>
            </div>
          </section>
        )}

        {note && <div className="set-hint" role="status" data-testid="v3-start-note">{note}</div>}

        <div className="start-foot">
          <label className="set-hint start-on-launch">
            <input type="checkbox" data-testid="v3-start-on-launch" checked={showOnLaunch}
              onChange={(e) => useSettings.getState().set("startOnLaunch", e.target.checked)} />
            Show this when Mosh opens
          </label>
          <button type="button" className="btn ghost" data-testid="v3-start-studio"
            onClick={() => { void stopPreview(); setPosture("studio"); }}>Open the studio</button>
        </div>
      </div>
    </div>
  );
}
