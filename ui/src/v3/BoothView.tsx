import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { CommandResult, LoopState, Snapshot, Track } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import {
  contributionLabel, loopActionTarget, loopAvailable, loopRecording, loopTarget, loopTargetLabel,
  type LoopAction,
} from "./loopPolicy";
import { phoneStatusLine } from "./phoneStatus";

// The Booth is the DESKTOP phone pad: the same eleven commands, the same availability
// model (loopPolicy.ts, a port of ui/src/phonepad/src/policy.ts), so a producer who
// learns one has learned the other. Every pass is preserved — Keep promotes one to the
// Lead track and rolls straight into the next, Again marks one as a redo and rewinds,
// and neither ever deletes audio.
//
// It does NOT create tracks on its own: entering the Booth is a navigation, not an edit,
// so the un-engaged state offers the setup rather than performing it.

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
  const [note, setNote] = useState<string | null>(null);
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

  const leadTrack = pickLeadTrack(snapshot.tracks, selectedTrackId, loop);
  // Monitoring is read from the SNAPSHOT (the engine resets it to automatic at every launch,
  // so local state would lie after a relaunch) and belongs to the shared input device.
  const takesTrack = loop?.engaged ? snapshot.tracks.find((t) => t.id === loop.takesTrackId) : undefined;
  const hearingMyself = takesTrack ? takesTrack.monitor !== "off" : false;

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
      const data = result.data as { detail?: unknown } | undefined;
      const detail = typeof data?.detail === "string" ? data.detail : null;
      setNote(result.ok ? detail : (result.error ?? `${command} failed`));
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
    await run("loop_setup", { trackId });
  };

  const toggleHearMyself = async () => {
    if (!loop?.takesTrackId) return;
    const result = await run("set_input_monitor", { trackId: loop.takesTrackId, mode: hearingMyself ? "off" : "automatic" });
    const data = result?.ok ? result.data as { applied?: unknown; reason?: unknown } | undefined : undefined;
    if (data?.applied === false)
      setNote(`Monitoring unchanged: ${typeof data.reason === "string" && data.reason ? data.reason : "the engine did not apply it"}`);
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

        {!loop?.engaged ? (
          <div className="booth-pads">
            <div className="set-hint">
              Pick the track you sing on, and Moshi keeps a Takes lane beside it. Nothing is recorded over.
            </div>
            <button type="button" className="btn pri" data-testid="v3-booth-setup" disabled={pending}
              onClick={() => void (leadTrack ? run("loop_setup", { trackId: leadTrack.id }) : addVocalTrack())}>
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
                title="Monitoring applies to the whole input device"
                onClick={() => void toggleHearMyself()}>
                Hear myself: {hearingMyself ? "On" : "Off"}
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
