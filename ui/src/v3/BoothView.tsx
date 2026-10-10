import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { CommandResult, LoopState, Snapshot, Track } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import {
  contributionLabel, loopActionTarget, loopAvailable, loopRecording, loopTarget, loopTargetLabel,
  type LoopAction,
} from "./loopPolicy";
import { phoneStatusLine } from "./phoneStatus";
import { trackPresetLabel } from "./MixInspector";
import { DEFAULT_VOCAL_CHAIN, defaultChainTargets, looksLikeSpeakers } from "./vocalSetup";

// The Booth is the DESKTOP phone pad: the same eleven commands, the same availability
// model (loopPolicy.ts, a port of ui/src/phonepad/src/policy.ts), so a producer who
// learns one has learned the other. Every pass is preserved — Keep promotes one to the
// Lead track and rolls straight into the next, Again marks one as a redo and rewinds,
// and neither ever deletes audio.
//
// It does NOT create tracks on its own: entering the Booth is a navigation, not an edit,
// so the un-engaged state offers the setup rather than performing it.
//
// The setup a producer DOES click starts a first-time singer somewhere sensible
// (vocalSetup.ts): a fresh Lead with no effects gets the default vocal chain on Lead and
// Takes, and a Mac playing through its own speakers starts with Hear myself off -- a live
// mic into laptop speakers howls.

const PADS = [
  { action: "record", command: "loop_record", testId: "v3-loop-record", label: "Put Me In", primary: true },
  { action: "keep", command: "loop_keep", testId: "v3-loop-keep", label: "Keep", primary: true },
  { action: "again", command: "loop_again", testId: "v3-loop-again", label: "Again", primary: false },
  { action: "hear", command: "loop_hear", testId: "v3-loop-hear", label: "Review", primary: false },
  { action: "play_all", command: "loop_play_all", testId: "v3-loop-play-all", label: "Play All", primary: false },
  { action: "stop", command: "loop_stop", testId: "v3-loop-stop", label: "Stop", primary: false },
] as const satisfies readonly { action: LoopAction; command: string; testId: string; label: string; primary: boolean }[];

/** A track the loop may use as the Lead — the audio track a voice lands on. Never a drum,
 *  MIDI or instrument track (the sampler/synth would silence a kept vocal), never a group,
 *  return, or the loop's own Takes lane. `isInstrument` is checked at the TRACK level too:
 *  an instrument track can carry no plugin rows at all (the dev mock's Bass is one). */
export function isLeadCandidate(t: Track, loop: LoopState | null | undefined): boolean {
  return !t.isGroup && !t.isReturn && t.id !== loop?.takesTrackId
    && t.type !== "drum" && t.type !== "midi"
    && !t.clips.some((c) => c.type === "midi")
    && !t.isInstrument
    && !(t.plugins ?? []).some((p) => p.isInstrument);
}

/** The selected track if it can be the Lead, else an armed candidate, else the first. */
export function pickLeadTrack(tracks: readonly Track[], selectedTrackId: string | null | undefined,
  loop: LoopState | null | undefined): Track | undefined {
  const candidates = tracks.filter((t) => isLeadCandidate(t, loop));
  return candidates.find((t) => t.id === selectedTrackId)
    ?? candidates.find((t) => t.armed)
    ?? candidates[0];
}

export function BoothView({ snapshot }: { snapshot: Snapshot }) {
  const loop = snapshot.loop;
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const pairing = useStore((s) => s.remoteStatus?.pairing);
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks);
  const setPosture = useV3((s) => s.setPosture);
  const setPhoneOpen = useV3((s) => s.setPhoneOpen);

  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // `rolling`: this answer describes a capture that is now in flight ("Recording from bar 1",
  // "Kept Part 1; recording from bar 3") -- see the recording-edge effect below.
  const [status, setStatus] = useState<{ text: string; rolling: boolean } | null>(null);
  const note = status?.text ?? null;
  const setNote = (text: string | null) => setStatus(text === null ? null : { text, rolling: false });
  const [bar, setBar] = useState("1");
  const [leadIn, setLeadIn] = useState("");

  const recording = loopRecording(loop);
  const context = { loop, selected, pending };
  const targetId = loopTarget(loop, selected);
  const shown = loop?.contributions.find((part) => part.id === targetId);
  const shownClipId = shown?.clipId;

  useEffect(() => { if (shownClipId) ensurePeaks(shownClipId); }, [shownClipId, ensurePeaks]);
  // A pass that no longer exists (undo, project reload) must not keep driving the pads.
  useEffect(() => {
    if (selected && !loop?.contributions.some((part) => part.id === selected)) setSelected(null);
  }, [loop, selected]);

  // The note is the last PAD's answer. A take can also end from outside the Booth (the
  // TopBar stop, Space, the Transport menu, the phone), and then "Recording from bar 1"
  // would sit under a stopped transport (2026-09-23 walkthrough). So when recording ENDS,
  // an answer that described the capture in flight is dropped. Anything else stays -- the
  // Stop pad's own "Stopped" above all -- whatever order the result and the snapshot land in.
  const wasRecording = useRef(recording);
  useEffect(() => {
    if (wasRecording.current && !recording) setStatus((s) => (s?.rolling ? null : s));
    wasRecording.current = recording;
  }, [recording]);

  const leadTrack = pickLeadTrack(snapshot.tracks, selectedTrackId, loop);
  // Monitoring is read from the SNAPSHOT (the engine resets it to automatic at every launch,
  // so local state would lie after a relaunch) and belongs to the shared input device.
  const takesTrack = loop?.engaged ? snapshot.tracks.find((t) => t.id === loop.takesTrackId) : undefined;
  const hearingMyself = takesTrack ? takesTrack.monitor !== "off" : false;
  // 2026-09-24 finding c -- a mode change sent mid-take comes back {applied:false,
  // deferred:true}: the snapshot honestly keeps showing the OLD mode until the take ends, so
  // this is the only thing that tells the producer their click registered. Cleared once the
  // snapshot's actual mode catches up (the deferred change landed) or the Takes track goes
  // away (session/project changed under it).
  const [pendingMonitor, setPendingMonitor] = useState<"off" | "automatic" | "on" | null>(null);
  useEffect(() => {
    if (pendingMonitor !== null && (!takesTrack || takesTrack.monitor === pendingMonitor)) setPendingMonitor(null);
  }, [pendingMonitor, takesTrack]);

  const outputDevice = snapshot.audio?.outputDevice ?? "";
  const onSpeakers = looksLikeSpeakers(outputDevice);
  // Set when the producer turns Hear myself ON while the output still looks like speakers
  // (headphones with an odd name, a booth monitor they trust): the guard below then stands
  // down instead of fighting them. Re-armed whenever the output changes.
  const speakerOverride = useRef(false);
  const autoMuting = useRef(false);
  useEffect(() => { speakerOverride.current = false; }, [outputDevice]);

  // Every loop command answers with a human `detail` — including the ones that committed
  // the edit but could not roll again ("Kept Part 2; recording did not restart: …"). Show
  // it: a half-applied result that reads as plain success is the one thing this line is for.
  //
  // `exec` can also THROW rather than answer {ok:false} — a dead WebView channel, a native
  // call that failed before it could build an envelope. Without the catch that rejection
  // escapes as an unhandled promise rejection: the button un-dims and nothing is said,
  // which from the live room is indistinguishable from a pad that does nothing at all.
  const run = async (command: string, args: Record<string, unknown> = {}): Promise<CommandResult | null> => {
    setPending(true);
    try {
      const result = await exec(command, args);
      const data = result.data as { detail?: unknown; currentId?: unknown } | undefined;
      const detail = typeof data?.detail === "string" ? data.detail : null;
      const text = result.ok ? detail : (result.error ?? `${command} failed`);
      const rolling = result.ok && typeof data?.currentId === "string" && data.currentId !== "";
      setStatus(text === null ? null : { text, rolling });
      if (result.ok) await useStore.getState().refresh();
      return result;
    } catch (error) {
      setNote(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      setPending(false);
    }
  };

  // No track can be the Lead (an empty session, or only the drum beat): make one. Two
  // existing commands, create_track then loop_setup, so each stays its own undo step.
  const addVocalTrack = async () => {
    const created = await run("create_track", { name: "Vocal" });
    if (!created?.ok) return;
    const trackId = (created.data as { trackId?: unknown } | undefined)?.trackId;
    if (typeof trackId !== "string" || !trackId) { setNote("create_track did not name the new track"); return; }
    await setupLoop(trackId);
  };

  // One monitoring change, honest about its outcome. Returns true when it applied (or is
  // pending until the take ends).
  const setMonitor = async (takesTrackId: string, targetMode: "off" | "automatic"): Promise<boolean> => {
    const result = await run("set_input_monitor", { trackId: takesTrackId, mode: targetMode });
    const data = result?.ok ? result.data as { applied?: unknown; deferred?: unknown; reason?: unknown } | undefined : undefined;
    if (data?.deferred === true) {
      // Recording is still rolling (2026-09-24 finding c): the change is honestly pending,
      // not applied -- show that instead of a toggle that looks like it did nothing.
      setPendingMonitor(targetMode);
      return true;
    }
    if (data?.applied === false) {
      setNote(`Monitoring unchanged: ${typeof data.reason === "string" && data.reason ? data.reason : "the engine did not apply it"}`);
      return false;
    }
    return !!result?.ok;
  };

  const toggleHearMyself = async () => {
    if (!loop?.takesTrackId) return;
    const targetMode: "off" | "automatic" = hearingMyself ? "off" : "automatic";
    if (targetMode === "automatic" && onSpeakers) speakerOverride.current = true;
    await setMonitor(loop.takesTrackId, targetMode);
  };

  // Headphones pulled out mid-session (or a relaunch, which resets monitoring to automatic,
  // on a Mac playing through its speakers): turn Hear myself off before the mic howls.
  // Keyed on the conditions only, not on run/setNote identity.
  useEffect(() => {
    if (!onSpeakers || !hearingMyself || !takesTrack || pendingMonitor !== null) return;
    if (speakerOverride.current || autoMuting.current) return;
    autoMuting.current = true;
    void setMonitor(takesTrack.id, "off").then((done) => {
      if (done) setNote(`Sound is playing through ${outputDevice}, so Hear myself is off. Plug in headphones, then turn it back on.`);
    }).finally(() => { autoMuting.current = false; });
  }, [onSpeakers, hearingMyself, takesTrack?.id, pendingMonitor, outputDevice]);

  // The default vocal chain for a fresh setup. Each preset application is its own undo
  // step (apply_track_preset), so ⌘Z peels it off without touching the setup itself.
  const addDefaultChain = async (leadId: string, takesId: string): Promise<string | null> => {
    const tracks = (useStore.getState().snapshot ?? snapshot).tracks;
    const targets = defaultChainTargets(tracks, leadId, takesId);
    if (targets.length === 0) return null;
    let file: string | undefined;
    try {
      const listed = await exec("list_presets", { plugin: "track-chain" });
      const presets = (listed?.data as { presets?: { name: string; file: string }[] } | undefined)?.presets ?? [];
      file = presets.find((p) => p.name === DEFAULT_VOCAL_CHAIN)?.file;
    } catch {
      file = undefined;
    }
    if (!file) return null;   // a build without the bundled chain: the setup still stands
    for (const target of targets) {
      const applied = await run("apply_track_preset", { trackId: target.id, file });
      if (!applied?.ok) return `Vocal chain not added to ${target.name}: ${applied?.error ?? "apply_track_preset failed"}`;
    }
    return `Added the ${trackPresetLabel(DEFAULT_VOCAL_CHAIN)} vocal chain; change it in Mix`;
  };

  const setupLoop = async (leadId: string) => {
    const setup = await run("loop_setup", { trackId: leadId });
    const takesId = (setup?.data as { takesTrackId?: unknown } | undefined)?.takesTrackId;
    if (!setup?.ok || typeof takesId !== "string" || !takesId) return;
    const notes: string[] = [];
    if (looksLikeSpeakers((useStore.getState().snapshot ?? snapshot).audio?.outputDevice)
      && await setMonitor(takesId, "off")) {
      notes.push("Hear myself is off: plug in headphones first");
    }
    const chain = await addDefaultChain(leadId, takesId);
    if (chain) notes.push(chain);
    if (notes.length > 0) setNote(notes.join(" · "));
  };

  const line = note ?? (loop?.blockReason || null);
  const phoneLine = phoneStatusLine(loop, pairing);

  return (
    <div className="booth-stage" data-testid="v3-booth">
      <div className="booth-main">
        <div className="hero-wrap">
          <div className="hero-lane" data-testid="v3-booth-hero">
            <SilhouetteWave
              peaks={shownClipId ? peaks[shownClipId] : undefined}
              selected
              live={recording}
              className="cwave bigwave"
            />
          </div>
        </div>

        {onSpeakers && (
          <div className="set-hint" role="alert" data-testid="v3-booth-speakers">
            Sound is playing through {outputDevice}. Plug in headphones before you sing: the
            mic hears the speakers and feeds back.
          </div>
        )}

        {!loop?.engaged ? (
          <div className="booth-pads">
            <div className="set-hint">
              Pick the track you sing on, and Moshi keeps a Takes lane beside it. Nothing is recorded over.
            </div>
            <button type="button" className="btn pri" data-testid="v3-booth-setup" disabled={pending}
              onClick={() => void (leadTrack ? setupLoop(leadTrack.id) : addVocalTrack())}>
              {leadTrack ? `Use ${leadTrack.name} as Lead` : "Add a Vocal track"}
            </button>
          </div>
        ) : (
          <>
            <div className="booth-pads" data-testid="v3-booth-pads">
              {PADS.map((pad) => (
                <button key={pad.testId} type="button"
                  className={`btn${pad.primary ? " pri" : ""}${pad.action === "record" && recording ? " on" : ""}`}
                  data-testid={pad.testId} disabled={!loopAvailable(pad.action, context)}
                  onClick={() => {
                    const target = loopActionTarget(pad.action, context);
                    void run(pad.command, target ? { targetId: target } : {});
                  }}>
                  {pad.action === "hear"
                    ? (recording ? "Review Current Recording" : "Review Selected Take")
                    : pad.label}
                </button>
              ))}
            </div>

            <div className="booth-monitor-row">
              <button type="button" className={`btn${hearingMyself ? " on" : ""}`} data-testid="v3-booth-monitor"
                aria-pressed={hearingMyself} disabled={!takesTrack || pending}
                title={pendingMonitor !== null
                  ? "Recording in progress -- will apply when the take ends"
                  : "Monitoring applies to the whole input device"}
                onClick={() => void toggleHearMyself()}>
                Hear myself: {hearingMyself ? "On" : "Off"}
                {pendingMonitor !== null ? ` (pending ${pendingMonitor === "off" ? "Off" : "On"})` : ""}
              </button>
            </div>

            {/* Engineering readouts stay one click away: useful to a producer steering
                passes, noise on a shared screen. */}
            <details className="booth-details" data-testid="v3-booth-details">
              <summary>Details</summary>
              <div className="booth-readout">
                <span data-testid="v3-loop-target">Target · {loopTargetLabel(loop, selected)}</span>
                <span className="set-hint">
                  bar {loop.listening.bar.toFixed(1)} · Entry {loop.listening.entryQn === null ? "—" : `${loop.listening.entryQn} qn`}
                  {" "}· Lead {loop.listening.leadQn} qn
                </span>
              </div>

              <div className="booth-forms">
                <button type="button" className="btn sm" data-testid="v3-loop-home"
                  disabled={!loopAvailable("home", context)} onClick={() => void run("loop_home")}>Start</button>
                <label className="set-hint">
                  Go to bar
                  <input className="field" type="number" min={1} value={bar} data-testid="v3-loop-bar"
                    disabled={!loopAvailable("navigate", context)} onChange={(e) => setBar(e.target.value)} />
                </label>
                <button type="button" className="btn sm" data-testid="v3-loop-go"
                  disabled={!loopAvailable("navigate", context)}
                  onClick={() => void run("loop_navigate", { bar: Number(bar) })}>Go</button>
                <label className="set-hint">
                  Lead-in qn
                  <input className="field" type="number" min={0} max={256}
                    value={leadIn === "" ? String(loop.listening.leadQn) : leadIn} data-testid="v3-loop-lead"
                    disabled={!loopAvailable("lead_in", context)} onChange={(e) => setLeadIn(e.target.value)} />
                </label>
                <button type="button" className="btn sm" data-testid="v3-loop-set-lead"
                  disabled={!loopAvailable("lead_in", context)}
                  onClick={() => void run("loop_lead_in", { leadQn: Number(leadIn === "" ? loop.listening.leadQn : leadIn) })}>
                  Set
                </button>
              </div>
            </details>
          </>
        )}

        <div className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className="btn ghost" data-testid="v3-booth-studio"
            onClick={() => setPosture("studio")}>← Studio</button>
          {/* Only once a phone is paired or attached — until then the TopBar's Phone pairs one. */}
          {phoneLine && (
            <button type="button" className={`btn ghost${pairing ? " on" : ""}`} data-testid="v3-booth-phone"
              onClick={() => setPhoneOpen(true)}>Phone</button>
          )}
          {phoneLine && <span className="booth-phone-status" data-testid="v3-booth-phone-status">{phoneLine}</span>}
        </div>
        {line && <div className="set-hint" role="status" data-testid="v3-booth-note">{line}</div>}
      </div>

      <aside className="booth-parts" data-testid="v3-booth-parts">
        <span className="sec">Parts</span>
        {(loop?.contributions.length ?? 0) === 0 && <div className="set-hint">Nothing recorded yet</div>}
        {(loop?.contributions ?? []).map((part) => (
          <button key={part.id} type="button" data-testid="v3-loop-part"
            className={`take${part.keeper ? " kept" : ""}${part.rejected ? " rejected" : ""}${part.id === selected ? " sel" : ""}`}
            disabled={recording || pending}
            aria-pressed={part.id === selected}
            onClick={() => setSelected(part.id === selected ? null : part.id)}>
            <b>{contributionLabel(part)}</b>
          </button>
        ))}
      </aside>
    </div>
  );
}
