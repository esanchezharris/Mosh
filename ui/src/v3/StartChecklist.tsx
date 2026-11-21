import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { microphonePermissionStatus, pickFiles, requestMicrophonePermission } from "../bridge";
import { setFileDropIntercept, looksLikeAudio, toBase64 } from "../hooks/useFileDrop";
import { QrImage } from "../ui/QrImage";
import type { Snapshot } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import { InputMeter } from "./InputMeter";
import { dropDrumBeat } from "./beats";
import {
  AUTOTUNE_KEYS, AUTOTUNE_SCALES, CHECK_ITEMS, beatClipOf, beatDone, checklistSettled, firstOpenItem, hasOwnChain,
  itemStates, micLaneOf, pickBackingTrack, repairTarget, resolveIds, setKeyArgs, songReady, tempoStillConfirmed, trackById,
  voiceBlocker, voicePresetOf,
  type AutoTuneScale, type CheckChoice, type CheckKey, type MicState,
} from "./startFlow";
import { useStartMemory } from "./startMemory";
import { createRecordingSong, friendlyError, speakerGuard, startIO, startRun } from "./startSong";
import { micFromEngineError, micFromPermission, type MicReport } from "./micCheck";
import {
  AUDIO_FILTERS, DROP_CAP_BYTES, confirmTempo, detectBpm, doubleBpm, formatBpm, halveBpm, importBeat,
  proposeTempo, clampBpm, type BeatSource,
} from "./beatImport";
import { pairingView } from "./phonePairing";
import {
  DEFAULT_VOCAL_CHAIN, TUNED_VOCAL_CHAIN, findPresetFile, looksLikeSpeakers, setupVocalLoop, switchVocalPreset,
} from "./vocalSetup";

// The first-run checklist: the friends-first way into Mosh for a rapper or singer
// (docs/LAUNCH-PAGE-BRIEF-2026-10-30.md). A small panel OVER the regular workspace, not a
// page and not a modal: the arrangement stays usable behind it. Three things to do, each
// in the real song: drop in a beat, check your voice, pair your phone. It sequences
// commands the rapper could run from the workspace; it adds none. Every edit goes through
// store.exec (startSong.ts).
//
// The song itself (Beat, Lead vocal, Ad-libs) is made by createRecordingSong, at launch
// (RecordingSetup.tsx) or from this panel's "New song".

const KEY_LOOSE = "loose";

const STATE_LABEL: Record<CheckChoice, string> = { todo: "To do", done: "Done", skipped: "Skipped" };

/** What the phone remote is doing right now, in plain words. */
function remotePhaseLabel(phase: string | undefined): string {
  switch (phase) {
    case "count_in": return "counting in";
    case "recording": return "recording";
    case "auditioning": return "playing a take back";
    case "playing": return "playing the song";
    default: return "ready";
  }
}

export function StartChecklist({ snapshot }: { snapshot: Snapshot }) {
  const open = useStartMemory((s) => s.open);
  return open ? <ChecklistPanel snapshot={snapshot} /> : null;
}

function ChecklistPanel({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const transitioning = useStore((s) => s.projectTransitioning);
  const mpActive = useStore((s) => s.mp.active);
  const remote = useStore((s) => s.remoteStatus);
  const lastError = useStore((s) => s.lastError);
  const peaks = useStore((s) => s.peaks);
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const setSettingsOpen = useV3((s) => s.setSettingsOpen);
  const setUpOnLaunch = useSettings((s) => s.get("startOnLaunch")) === true;

  const memory = useStartMemory();
  const { beat, phone, progress, settingUp, songError, note } = memory;
  const { patchBeat, patchPhone, setItem, setNote } = memory;
  const ids = resolveIds(snapshot, memory.ids);

  const [current, setCurrent] = useState<CheckKey | null>(() => firstOpenItem(progress));
  const [busy, setBusy] = useState(false);
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
  const metronomeBefore = useRef<boolean | null>(null);
  // How many beat imports are in flight: a drop is not gated by the disabled buttons.
  const importing = useRef(0);

  const recording = !!snapshot.transport?.recording;
  const lead = trackById(snapshot, ids.leadTrackId);
  const lane = micLaneOf(snapshot, ids);
  const hearingMyself = lane ? lane.monitor !== "off" : false;
  const outputDevice = snapshot.audio?.outputDevice ?? "";
  const onSpeakers = looksLikeSpeakers(outputDevice);
  const leadOwnChain = hasOwnChain(lead) && voicePresetOf(lead) === "none";
  // The producer's own effects sit on a track that also has a bundled preset: switching
  // would re-insert the new chain ahead of the fader, i.e. AFTER their effects
  // (apply_track_preset puts a fresh group there). Leave the switch to the mixer rather
  // than reorder their chain.
  const leadHasOwnEffects = hasOwnChain(lead) && !leadOwnChain;
  const chainNotRequired = (presets !== null && !presets.clean) || leadOwnChain;
  const blocker = voiceBlocker({ snapshot, ids, mic, chainNotRequired });
  const voiceReady = blocker === null;
  const disabledAll = busy || transitioning || recording || settingUp;
  const phoneConnected = snapshot.loop?.phoneConnected === true;
  const states = itemStates({ snapshot, ids, beat, progress, voiceReady, phoneConnected });
  const settled = checklistSettled(progress) && CHECK_ITEMS.every((item) => states[item.key] !== "todo");

  const busyWhile = async <T,>(work: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try { return await work(); } finally { setBusy(false); }
  };
  /** The item after `key` that is still to do, else none (the "You're set" card shows). */
  const advanceFrom = (key: CheckKey) => {
    const at = CHECK_ITEMS.findIndex((item) => item.key === key);
    const next = CHECK_ITEMS.slice(at + 1).find((item) => states[item.key] === "todo")
      ?? CHECK_ITEMS.find((item) => item.key !== key && states[item.key] === "todo");
    setCurrent(next?.key ?? null);
  };

  useEffect(() => {
    void microphonePermissionStatus().then((r) => setMic(r.status)).catch(() => setMic("unknown"));
  }, []);

  // ── Beat ──────────────────────────────────────────────────────────────────────────
  const beatClip = beatClipOf(snapshot, ids, beat);
  useEffect(() => { if (beatClip?.id) ensurePeaks(beatClip.id); }, [beatClip?.id, ensurePeaks]);
  // The beat is a fact about the song: once it is in place, remember that it was done.
  useEffect(() => { if (states.beat === "done") setItem("beat", "done"); }, [states.beat, setItem]);

  const ensureBeatTrack = async (): Promise<string | null> => {
    const m = useStartMemory.getState();
    const fresh = useStore.getState().snapshot;
    const known = resolveIds(fresh, m.ids).backingTrackId;
    if (known) return known;
    const found = fresh ? pickBackingTrack(fresh.tracks, fresh.loop) : undefined;
    let id = found?.id ?? null;
    if (!id) {
      const created = await startRun("create_track", { name: "Beat", type: "audio" });
      const newId = (created?.data as { trackId?: unknown } | undefined)?.trackId;
      id = typeof newId === "string" ? newId : null;
    }
    if (id) useStartMemory.getState().patch({ ids: { ...useStartMemory.getState().ids, backingTrackId: id } });
    return id;
  };

  const addBeat = async (source: BeatSource, fileName: string) => {
    // One beat at a time. Buttons are disabled while busy, but a DROP is not a button: two
    // overlapping imports would stack both beats at bar 1.
    if (importing.current > 0) { setNote("One beat at a time: wait for this one to land."); return; }
    importing.current += 1;
    try {
      await busyWhile(async () => {
        setNote(null);
        const beatTrackId = await ensureBeatTrack();
        if (!beatTrackId) { setNote("The Beat track couldn't be made."); return; }
        // What is replaced: the beat this checklist imported, else the one already on the
        // Beat track, so "Choose a different beat…" never stacks a second one.
        const m = useStartMemory.getState();
        const fresh = useStore.getState().snapshot;
        const onTrack = trackById(fresh, beatTrackId)?.clips ?? [];
        const remembered = m.beat.clipId && onTrack.some((c) => c.id === m.beat.clipId) ? m.beat.clipId : null;
        const previous = remembered ?? beatClipOf(fresh, { ...m.ids, backingTrackId: beatTrackId }, m.beat)?.id ?? null;
        const added = await importBeat(startRun, source, beatTrackId, previous);
        if (!added.ok || !added.clipId) { setNote(added.error ? `Couldn't add that beat: ${added.error}` : "Couldn't add that beat."); return; }
        // Remember the new clip before detection runs, so nothing in between can lose it.
        patchBeat({ clipId: added.clipId, fileName, proposal: null, confirmed: false, confirmedBpm: null, adopted: false, skipped: false });
        await useStore.getState().refresh();
        const detected = await detectBpm(startRun, added.clipId);
        const proposal = proposeTempo(detected, fileName, useStore.getState().snapshot?.session.tempo ?? 120);
        patchBeat({ proposal, bpmText: formatBpm(proposal.bpm) });
        setNote(added.error);   // null, or "the old one is still there"
      });
    } finally {
      importing.current -= 1;
    }
  };

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

  // While the Beat item is open, a file dropped ANYWHERE on the workspace is the beat: it
  // lands on the Beat track at bar 1 and its tempo is read. With the item closed (or the
  // checklist gone) a drop is the workspace's ordinary import again.
  const beatOpen = current === "beat" && !!lead;
  useEffect(() => {
    if (!beatOpen) return;
    const clear = setFileDropIntercept(recording ? () => setNote("Stop the take first.") : dropBeat);
    const enter = (e: DragEvent) => { if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) setDragging(true); };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", leave);
    return () => {
      clear();
      setDragging(false);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", leave);
    };
  }, [beatOpen, recording, dropBeat, setNote]);

  // A blank or non-numeric field is NOT 0 → 40 BPM: it is "not typed yet". The Use button
  // is disabled then, and anything that needs a number falls back to the session tempo.
  const typedBpm = Number(beat.bpmText);
  const bpmTyped = beat.bpmText.trim() !== "" && Number.isFinite(typedBpm) && typedBpm > 0;
  const bpmValue = clampBpm(bpmTyped ? typedBpm : (snapshot.session.tempo ?? 120));
  const setBpm = (bpm: number) => patchBeat({ bpmText: formatBpm(clampBpm(bpm)), confirmed: false, confirmedBpm: null });
  const beatConfirmed = tempoStillConfirmed(snapshot, beat);

  const stopPreview = async () => {
    if (!previewing && metronomeBefore.current === null) return;
    setPreviewing(false);
    await startRun("set_transport", { action: "stop" });
    if (metronomeBefore.current !== null) {
      await startRun("set_metronome", { enabled: metronomeBefore.current });
      metronomeBefore.current = null;
    }
  };
  const togglePreview = () => busyWhile(async () => {
    if (previewing) { await stopPreview(); return; }
    if (!beatClip) return;
    metronomeBefore.current = !!useStore.getState().snapshot?.session.metronome;
    await startRun("set_tempo", { bpm: bpmValue });
    await startRun("set_transport", { loop: true, loopStart: beatClip.start, loopEnd: beatClip.start + beatClip.length });
    await startRun("set_metronome", { enabled: true });
    await startRun("set_transport", { action: "play", position: beatClip.start });
    setPreviewing(true);
  });

  const useTempo = () => busyWhile(async () => {
    if (!beatClip) return;
    await stopPreview();
    const error = await confirmTempo(startRun, bpmValue, beatClip);
    if (error) { setNote(friendlyError("set_tempo", error)); return; }
    patchBeat({ confirmed: true, confirmedBpm: clampBpm(bpmValue), adopted: false });
    setItem("beat", "done");
    advanceFrom("beat");
  });

  // Leaving the Beat item by ANY route ends the preview; closing the checklist (or a
  // project swap) restores the click and stops the loop too. The saved click lives in a
  // ref the cleanup can still read.
  useEffect(() => {
    if (current !== "beat" && (previewing || metronomeBefore.current !== null)) void stopPreview();
  }, [current]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    const saved = metronomeBefore.current;
    if (saved === null) return;
    metronomeBefore.current = null;
    const execNow = useStore.getState().exec;
    void execNow("set_transport", { action: "stop" }).catch(() => undefined)
      .then(() => execNow("set_metronome", { enabled: saved })).catch(() => undefined);
  }, []);

  const useDrumBeat = () => busyWhile(async () => {
    const dropped = await dropDrumBeat();
    if (!dropped) { setNote(useStore.getState().lastError ?? "The drum beat couldn't be added."); return; }
    patchBeat({ confirmed: true, skipped: false });
    setItem("beat", "done");
    advanceFrom("beat");
  });

  const skip = (key: CheckKey) => {
    if (key === "beat") patchBeat({ skipped: true });
    if (key === "phone") patchPhone({ skipped: true });
    setItem(key, "skipped");
    advanceFrom(key);
  };

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
    const fresh = useStore.getState().snapshot;
    const micLane = micLaneOf(fresh, resolveIds(fresh, useStartMemory.getState().ids));
    if (!micLane) return;
    if (micLane.armed) { setMicReport(null); return; }
    const probe = await exec("arm_track", { trackId: micLane.id, armed: true }).catch(() => null);
    if (!probe) { setMicReport(micFromEngineError("The microphone didn't answer")); return; }
    if (!probe.ok) { setMicReport(micFromEngineError(probe.error)); return; }
    const data = probe.data as { applied?: unknown; reason?: unknown } | undefined;
    setMicReport(data?.applied === false ? micFromEngineError(typeof data.reason === "string" ? data.reason : "no input device") : null);
    await useStore.getState().refresh();
  }, [exec]);

  useEffect(() => {
    if (current !== "voice") return;
    void checkMic();
    void (async () => {
      const [clean, tuned] = await Promise.all([findPresetFile(startIO, DEFAULT_VOCAL_CHAIN), findPresetFile(startIO, TUNED_VOCAL_CHAIN)]);
      setPresets({ clean, tuned });
    })();
  }, [current, ids.leadTrackId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const retryMic = () => busyWhile(async () => {
    if (micReport?.audioSettings) await startRun("retry_audio_device", {});
    await checkMic();
  });

  /** The Key/Scale the Lead's AutoTune is set to now, or null (no tuner, or Chromatic). */
  const currentTunerKey = (): { keyLabel: string; scale: AutoTuneScale } | null => {
    const tuner = (trackById(useStore.getState().snapshot, ids.leadTrackId)?.plugins ?? []).find((p) => p.type === "moshAutoTune");
    const keyParam = tuner?.params.find((p) => p.index === 0);
    const scaleParam = tuner?.params.find((p) => p.index === 1);
    if (!keyParam || !scaleParam) return null;
    const scaleLabel = AUTOTUNE_SCALES[Math.round(Math.min(1, Math.max(0, scaleParam.value)) * (AUTOTUNE_SCALES.length - 1))];
    if (!scaleLabel || scaleLabel === "Chromatic") return null;
    const keyLabelNow = AUTOTUNE_KEYS[Math.round(Math.min(1, Math.max(0, keyParam.value)) * (AUTOTUNE_KEYS.length - 1))];
    return keyLabelNow ? { keyLabel: keyLabelNow, scale: scaleLabel } : null;
  };
  /** Opening the Tuned card starts from the key the tuner already has, so "Update the key"
   *  or a Fix never erases it with the default. */
  const openTuned = () => {
    const tunerKey = currentTunerKey();
    if (tunerKey) { setKeyLabel(tunerKey.keyLabel); setScale(tunerKey.scale); }
    setTunedOpen(true);
  };

  const switchVoice = (to: "clean" | "tuned", keep?: { keyLabel: string; scale: AutoTuneScale } | null) => busyWhile(async () => {
    if (!ids.leadTrackId) return;
    const key = to !== "tuned" ? undefined
      : keep ? keep
        : keyLabel !== KEY_LOOSE ? { keyLabel, scale } : { keyLabel: "C", scale: "Chromatic" as const };
    const r = await switchVocalPreset(startIO, { leadId: ids.leadTrackId, takesId: ids.takesTrackId, to, key });
    if (!r.ok) { setNote(r.error); return; }
    const keyArgs = key ? setKeyArgs(key.keyLabel, key.scale) : null;
    if (keyArgs) await startRun("set_key", keyArgs);
    setNote(to === "tuned" ? "Tuned Lead is on your voice." : "Clean Lead is on your voice.");
    if (to === "tuned") setTunedOpen(false);
  });

  const toggleHearMyself = () => busyWhile(async () => {
    if (!lane) return;
    const target = hearingMyself ? "off" : "automatic";
    if (target === "automatic" && onSpeakers) speakerGuard.markOverride();
    await startIO.setMonitor(lane.id, target);
  });

  const confirmVoice = () => {
    setItem("voice", "done");
    advanceFrom("voice");
  };

  // ── Phone ─────────────────────────────────────────────────────────────────────────
  const pairing = remote?.pairing ?? null;
  useEffect(() => {
    if (!phoneConnected) return;
    if (!phone.everConnected) patchPhone({ everConnected: true });
    setItem("phone", "done");
  }, [phoneConnected]);   // eslint-disable-line react-hooks/exhaustive-deps
  const view = pairingView({ requested: pairRequested || !!pairing, pairing, error: pairError,
    everConnected: phoneConnected || phone.everConnected, shownAtMs: pairShownAt, nowMs: now });
  const phoneOpen = current === "phone";

  useEffect(() => {
    if (!phoneOpen || view.phase === "connected" || view.phase === "idle") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phoneOpen, view.phase]);
  useEffect(() => {
    if (phoneOpen && view.phase === "expired") void useStore.getState().refreshRemote();
  }, [phoneOpen, view.phase]);
  useEffect(() => {
    if (pairRequested && !pairing && lastError && /remote companion|phone/i.test(lastError)) setPairError(lastError);
  }, [lastError, pairRequested, pairing]);
  // The phone's start error lives in the app's ONE error slot: leave it behind with the
  // item, along with the checklist's own record of it. Read through a ref: the cleanup
  // belongs to the render the rapper ARRIVED in, when there was no error yet.
  const pairErrorRef = useRef(pairError);
  pairErrorRef.current = pairError;
  useEffect(() => () => {
    if (pairErrorRef.current) {
      useStore.getState().setLastError(null);
      setPairError(null);
      setPairRequested(false);
    }
  }, [current]);

  const showCode = () => busyWhile(async () => {
    useStore.getState().setLastError(null);
    setPairError(null);
    // The remote records onto a Takes lane under the Lead vocal and moves the takes you
    // keep up onto it. Set that pair up FIRST (with the Lead's chain on the Takes lane), so
    // the first Record from the phone already sounds like the voice check did.
    const fresh = useStore.getState().snapshot ?? snapshot;
    const freshIds = resolveIds(fresh, useStartMemory.getState().ids);
    if (!freshIds.leadTrackId) { setPairError("There is no vocal track for the phone to record onto"); return; }
    if (!songReady(fresh, freshIds)) {
      const setup = await setupVocalLoop(startIO, freshIds.leadTrackId, fresh);
      if (!setup.setup?.ok || !setup.takesId) {
        setPairRequested(true);
        setPairError(friendlyError("loop_setup", setup.setup?.error ?? "the remote couldn't be set up on your vocal track"));
        return;
      }
      if (setup.notes.length > 0) setNote(setup.notes.join(" · "));
    }
    setPairRequested(true);
    setPairShownAt(Date.now());
    setNow(Date.now());
    await useStore.getState().startRemotePairing();
    const after = useStore.getState();
    if (!after.remoteStatus?.pairing && after.lastError) setPairError(after.lastError);
  });

  // ── layout ────────────────────────────────────────────────────────────────────────
  const leadPreset = voicePresetOf(lead);
  const lanePreset = lane && lane.id !== lead?.id ? voicePresetOf(lane) : leadPreset;
  const needsFix = leadPreset === "lost-tuner" || leadPreset === "stacked" || leadPreset === "mixed"
    || (lanePreset !== leadPreset && (leadPreset === "clean" || leadPreset === "tuned"));
  const loopBlock = snapshot.loop?.blockReason ?? "";
  const keptCount = (snapshot.loop?.contributions ?? []).filter((p) => p.keeper).length;
  const newSong = () => { void createRecordingSong().then((made) => { if (made) setCurrent("beat"); }); };

  const itemHead = (key: CheckKey, label: string, hint: string) => (
    <button type="button" className="check-head" data-testid={`v3-check-item-${key}`} data-state={states[key]}
      aria-expanded={current === key} disabled={!lead}
      onClick={() => setCurrent(current === key ? null : key)}>
      <span className={`check-dot ${states[key]}`} aria-hidden="true">{states[key] === "done" ? "✓" : states[key] === "skipped" ? "–" : ""}</span>
      <span className="check-label"><b>{label}</b><span className="set-hint">{hint}</span></span>
      <span className="set-hint check-state">{STATE_LABEL[states[key]]}</span>
    </button>
  );

  return (
    <aside className="start-check" data-testid="v3-checklist" data-current={current ?? ""} aria-label="Getting started">
      <header className="check-top">
        <b>Getting started</b>
        <button type="button" className="icon-x" data-testid="v3-check-dismiss" aria-label="Close getting started"
          title="Close. File › Getting started brings it back." onClick={() => memory.dismiss()}>×</button>
      </header>

      <div className="check-body">
        {transitioning && <div className="set-hint" role="status">Opening…</div>}

        {(settingUp || songError || !lead) && (
          <section className="check-card" data-testid="v3-check-song">
            {settingUp ? (
              <p className="set-hint" role="status" data-testid="v3-check-song-busy">
                Setting up your song: a track for your beat, one for your lead vocal, one for ad-libs.
              </p>
            ) : (
              <>
                {songError
                  ? <p className="set-hint" role="alert" data-testid="v3-check-song-error">Couldn't set up the song: {songError}</p>
                  : <p className="set-hint">This song has no vocal track yet.</p>}
                <div className="start-actions">
                  <button type="button" className="btn pri sm" data-testid="v3-check-new-song" disabled={disabledAll || mpActive}
                    title={mpActive ? "A shared session keeps its own song" : undefined}
                    onClick={newSong}>{songError ? "Try again" : "Set up a new song"}</button>
                </div>
              </>
            )}
          </section>
        )}

        {settled && current === null && (
          <section className="check-card check-set" data-testid="v3-check-set">
            <b>You're set.</b>
            <p className="set-hint">Press Record when you're ready{states.phone === "done" ? ", here or on your phone" : ""}. Every pass is kept as a take.</p>
            <button type="button" className="btn pri sm" data-testid="v3-check-close" onClick={() => memory.close()}>Close</button>
          </section>
        )}

        {/* ── Beat ── */}
        <section className={`check-item${current === "beat" ? " open" : ""}`}>
          {itemHead("beat", "Beat", "Drop in the beat you're recording over")}
          {beatOpen && (
            <div className="check-panel" data-testid="v3-check-beat">
              <div className={`start-drop${dragging ? " armed" : ""}`} data-testid="v3-check-drop" data-armed={dragging ? true : undefined}>
                {beatClip ? (
                  <div className="start-beat-wave">
                    <SilhouetteWave peaks={peaks[beatClip.id]} selected className="cwave" />
                    <span className="set-hint">{beat.fileName || beatClip.name}</span>
                  </div>
                ) : (
                  <span>Drag a .wav, .mp3 or .aiff anywhere on the window</span>
                )}
              </div>
              <div className="start-actions">
                <button type="button" className={`btn sm${beatClip ? "" : " pri"}`} data-testid="v3-check-choose" disabled={disabledAll}
                  onClick={() => void chooseBeat()}>{beatClip ? "Choose a different beat…" : "Choose a file…"}</button>
                {!beatClip && (
                  <button type="button" className="btn ghost sm" data-testid="v3-check-drum-beat" disabled={disabledAll}
                    onClick={() => void useDrumBeat()}>No beat? Use a drum beat</button>
                )}
              </div>

              {beatClip && (
                <div className="start-tempo" data-testid="v3-check-tempo">
                  <p className="start-lead" data-testid="v3-check-tempo-line">
                    {beatConfirmed
                      ? <>Your beat is at <b>{formatBpm(beat.confirmedBpm ?? bpmValue)}</b> BPM.</>
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
                      <input className="field" type="number" min={40} max={240} step={1} data-testid="v3-check-bpm"
                        value={beat.bpmText} disabled={disabledAll}
                        onChange={(e) => patchBeat({ bpmText: e.target.value, confirmed: false })} />
                    </label>
                    <button type="button" className="btn sm" data-testid="v3-check-bpm-half" disabled={disabledAll}
                      onClick={() => setBpm(halveBpm(bpmValue))}>÷2</button>
                    <button type="button" className="btn sm" data-testid="v3-check-bpm-double" disabled={disabledAll}
                      onClick={() => setBpm(doubleBpm(bpmValue))}>×2</button>
                  </div>
                  <div className="start-actions">
                    <button type="button" className={`btn sm${previewing ? " on" : ""}`} data-testid="v3-check-preview"
                      aria-pressed={previewing} disabled={disabledAll && !previewing}
                      onClick={() => void togglePreview()}>{previewing ? "■ Stop" : "▶ Hear it with the click"}</button>
                    {!beatConfirmed && (
                      <button type="button" className="btn pri sm" data-testid="v3-check-bpm-confirm" disabled={disabledAll || !bpmTyped}
                        onClick={() => void useTempo()}>Use {formatBpm(bpmValue)} BPM</button>
                    )}
                  </div>
                  <p className="set-hint">If the click drifts from the beat, try ÷2 or ×2.</p>
                </div>
              )}
              {states.beat !== "done" && !beatDone(snapshot, ids, beat) && (
                <button type="button" className="btn ghost sm check-skip" data-testid="v3-check-skip-beat" disabled={disabledAll}
                  onClick={() => skip("beat")}>Skip for now</button>
              )}
            </div>
          )}
        </section>

        {/* ── Voice ── */}
        <section className={`check-item${current === "voice" ? " open" : ""}`}>
          {itemHead("voice", "Voice", "Check the mic and hear yourself")}
          {current === "voice" && lead && (
            <div className="check-panel" data-testid="v3-check-voice">
              <p className="set-hint" data-testid="v3-check-voice-say">
                Put your headphones on and say something. You should hear yourself{leadPreset === "tuned" ? ", tuned" : ""}.
              </p>
              <div className="start-room" data-testid="v3-check-room">
                <div className={`start-row${micReport && micReport.problem !== "ok" ? " warn" : ""}`} data-testid="v3-check-mic">
                  <b>Microphone</b>
                  <span className="set-hint">{micReport && micReport.problem !== "ok" ? micReport.text : (snapshot.audio?.inputDevice || "Ready")}</span>
                  {micReport?.audioSettings && (
                    <button type="button" className="btn sm" data-testid="v3-check-audio-settings" onClick={() => setSettingsOpen(true)}>Audio settings</button>
                  )}
                  {micReport?.retry && (
                    <button type="button" className="btn sm" data-testid="v3-check-mic-retry" disabled={disabledAll} onClick={() => void retryMic()}>Retry</button>
                  )}
                </div>
                <div className={`start-row${onSpeakers ? " warn" : ""}`} data-testid="v3-check-headphones">
                  <b>Headphones</b>
                  <span className="set-hint">
                    {onSpeakers
                      ? `Sound is coming out of ${outputDevice}. Plug in headphones so the mic doesn't hear the beat. Hear myself stays off until you do.`
                      : outputDevice || "Ready"}
                  </span>
                </div>
                <div className="start-row">
                  <button type="button" className={`btn sm${hearingMyself ? " on" : ""}`} data-testid="v3-check-monitor"
                    aria-pressed={hearingMyself} disabled={!lane || disabledAll} onClick={() => void toggleHearMyself()}>
                    Hear myself: {hearingMyself ? "On" : "Off"}
                  </button>
                  <InputMeter trackId={lane?.id} monitoring={hearingMyself} />
                </div>
                {loopBlock && <p className="set-hint" role="alert">{loopBlock}</p>}
              </div>

              {leadOwnChain ? (
                <p className="set-hint" data-testid="v3-check-own-chain">Keeping your own effects on this voice. Change them in the mixer.</p>
              ) : presets !== null && !presets.clean ? (
                <p className="set-hint">Plain voice: this build has no vocal sounds.</p>
              ) : (
                <>
                  {leadHasOwnEffects && (
                    <p className="set-hint" data-testid="v3-check-own-effects">
                      Your own effects are on this voice too, so switch sounds in the mixer, where you can see the order.
                    </p>
                  )}
                  <div className="start-presets" role="radiogroup" aria-label="Vocal sound">
                    {presets?.tuned && (
                      <button type="button" role="radio" aria-checked={leadPreset === "tuned"} data-testid="v3-check-tuned"
                        className={`start-preset${leadPreset === "tuned" ? " sel" : ""}`} disabled={disabledAll || leadHasOwnEffects}
                        onClick={openTuned}>
                        <b>Tuned Lead</b>
                        <span className="set-hint">Pitch correction that snaps you to the key.</span>
                      </button>
                    )}
                    <button type="button" role="radio" aria-checked={leadPreset === "clean"} data-testid="v3-check-clean"
                      className={`start-preset${leadPreset === "clean" ? " sel" : ""}`} disabled={disabledAll || leadHasOwnEffects}
                      onClick={() => { if (leadPreset !== "clean") void switchVoice("clean"); }}>
                      <b>Clean Lead</b>
                      <span className="set-hint">Your voice, cleaned up and evened out. No tuning.</span>
                    </button>
                  </div>
                </>
              )}
              {tunedOpen && (
                <div className="start-key" data-testid="v3-check-key">
                  <label className="set-hint">Key
                    <select className="field" data-testid="v3-check-key-root" value={keyLabel} disabled={disabledAll}
                      onChange={(e) => setKeyLabel(e.target.value)}>
                      <option value={KEY_LOOSE}>I don't know, keep it loose</option>
                      {AUTOTUNE_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </label>
                  {keyLabel !== KEY_LOOSE && (
                    <label className="set-hint">Scale
                      <select className="field" data-testid="v3-check-key-scale" value={scale} disabled={disabledAll}
                        onChange={(e) => setScale(e.target.value as AutoTuneScale)}>
                        <option value="Major">Major</option>
                        <option value="Minor">Minor</option>
                      </select>
                    </label>
                  )}
                  <button type="button" className="btn pri sm" data-testid="v3-check-tuned-apply" disabled={disabledAll}
                    onClick={() => void switchVoice("tuned")}>{leadPreset === "tuned" ? "Update the key" : "Use Tuned Lead"}</button>
                  <button type="button" className="btn ghost sm" onClick={() => setTunedOpen(false)}>Cancel</button>
                </div>
              )}
              {needsFix && !leadOwnChain && !leadHasOwnEffects && (
                <div className="start-warn" role="alert" data-testid="v3-check-fix-chain">
                  Your vocal sound needs a quick fix.
                  <button type="button" className="btn sm" disabled={disabledAll}
                    onClick={() => {
                      // Repair to the preset that is actually there (a doubled Clean chain
                      // stays Clean) and keep the key the tuner already had.
                      const target = repairTarget(lead);
                      void switchVoice(target, target === "tuned" ? currentTunerKey() : null);
                    }}>Fix it</button>
                </div>
              )}

              <div className="start-actions">
                <button type="button" className="btn pri sm" data-testid="v3-check-voice-ok" disabled={!voiceReady || disabledAll}
                  onClick={confirmVoice}>{voiceReady ? "Sounds right" : blocker}</button>
                {states.voice !== "done" && (
                  <button type="button" className="btn ghost sm" data-testid="v3-check-skip-voice" disabled={busy}
                    onClick={() => skip("voice")}>Skip for now</button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* ── Phone ── */}
        <section className={`check-item${current === "phone" ? " open" : ""}`}>
          {itemHead("phone", "Phone", "Use your iPhone as a remote (optional)")}
          {phoneOpen && lead && (
            <div className="check-panel" data-testid="v3-check-phone">
              <p className="set-hint">Record, keep and redo from across the room. Your voice still goes into this Mac's
                microphone; the phone only presses the buttons. Phone and Mac need the same Wi-Fi. If your Mac asks whether
                Mosh can accept network connections, choose Allow.</p>
              {view.phase === "idle" && (
                <button type="button" className="btn pri sm" data-testid="v3-check-show-code" disabled={disabledAll}
                  onClick={() => void showCode()}>Show the code</button>
              )}
              {view.phase === "starting" && <p className="set-hint" role="status">Starting the phone link…</p>}
              {view.phase === "failed" && (
                <div className="start-warn" role="alert" data-testid="v3-check-pair-failed">
                  Couldn't start the phone link: {pairError}. You can skip this; the Record button here does the same job.
                  <button type="button" className="btn sm" disabled={disabledAll} onClick={() => void showCode()}>Try again</button>
                </div>
              )}
              {(view.phase === "showing" || view.phase === "expired") && pairing && (
                <div className={`start-qr${view.phase === "expired" ? " expired" : ""}`}>
                  <QrImage url={pairing.padUrl} className="phone-qr check-qr" waitClassName="phone-qr-wait"
                    alt="Phone remote pairing code" testId="v3-check-qr" />
                  <div className="start-qr-side">
                    <p className="set-hint">Scan with the iPhone Camera. It opens in Safari, nothing to install.</p>
                    <div className="phone-url" data-testid="v3-check-pad-url">{pairing.padUrl}</div>
                    {view.phase === "expired" ? (
                      <p className="set-hint warn" data-testid="v3-check-pair-expired">This code expired.</p>
                    ) : view.countdown && (
                      <p className={`set-hint${view.warn ? " warn" : ""}`} data-testid="v3-check-pair-ttl">Code valid for {view.countdown}</p>
                    )}
                    {view.canRemint && (
                      <button type="button" className="btn sm" data-testid="v3-check-new-code" disabled={disabledAll}
                        onClick={() => void showCode()}>New code</button>
                    )}
                  </div>
                </div>
              )}
              {view.stalled && view.phase !== "connected" && (
                <p className="set-hint" data-testid="v3-check-pair-help">
                  Phone not here yet? Both need the same Wi-Fi, and any VPN on the Mac or phone should be paused.
                  {pairing ? ` This Mac's address is ${pairing.host}; you can type the address above into Safari.` : ""}
                </p>
              )}
              {view.phase === "connected" && (
                <div className="check-remote" role="status" data-testid="v3-check-phone-connected">
                  <p className="start-lead">{phoneConnected ? "Phone connected." : "Your phone was connected. Open the page on it again to carry on."}</p>
                  <p className="set-hint" data-testid="v3-check-phone-target">
                    Record, Keep, Again and Hear on your phone work on <b>{lead.name}</b>.
                  </p>
                  <p className="set-hint" data-testid="v3-check-phone-live">
                    Right now: {remotePhaseLabel(snapshot.loop?.phase)} · {keptCount} {keptCount === 1 ? "take" : "takes"} kept
                  </p>
                  {!songReady(snapshot, ids) && (
                    <button type="button" className="btn sm" data-testid="v3-check-phone-repair" disabled={disabledAll}
                      onClick={() => void busyWhile(async () => { await setupVocalLoop(startIO, lead.id, snapshot); })}>
                      Point the phone at {lead.name}
                    </button>
                  )}
                </div>
              )}
              {states.phone !== "done" && (
                <button type="button" className="btn ghost sm check-skip" data-testid="v3-check-skip-phone" disabled={busy}
                  onClick={() => skip("phone")}>Skip, no phone</button>
              )}
            </div>
          )}
        </section>

        {note && <div className="set-hint check-note" role="status" data-testid="v3-check-note">{note}</div>}
      </div>

      <footer className="check-foot">
        <label className="set-hint start-on-launch">
          <input type="checkbox" data-testid="v3-check-on-launch" checked={setUpOnLaunch}
            onChange={(e) => useSettings.getState().set("startOnLaunch", e.target.checked)} />
          Set up a song when Mosh opens
        </label>
        {lead && (
          <button type="button" className="btn ghost sm" data-testid="v3-check-new-song" disabled={disabledAll || mpActive}
            title={mpActive ? "A shared session keeps its own song" : "A new song with Beat, Lead vocal and Ad-libs tracks"}
            onClick={newSong}>New song</button>
        )}
      </footer>
    </aside>
  );
}
