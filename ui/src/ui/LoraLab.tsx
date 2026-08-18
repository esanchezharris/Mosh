// LoRA Lab — train an adapter on your own music, then LISTEN to the checkpoints
// and keep the one that sounds right.
//
// The design follows one finding from the round that built the local trainer:
// **best-scoring is not best-sounding**. A 25-epoch adapter had better character
// by ear than a 44-epoch one scoring 0.14 higher, the in-run eval probe stayed
// flat (0.885 -> 0.899) while output quality plainly climbed, and the epoch count
// that worked moved 145 -> 44 -> 11 across three corpora of 33 / 189 / 424 clips.
// No single recipe fits, and no available number decides it.
//
// So the Lab is a take sheet, not a dashboard. The biggest elements are play
// buttons and waveforms; the loss curve and the probe are behind a disclosure,
// and no score appears beside a take. What a producer does here is train, listen,
// and choose — the same loop as comping vocal takes, because it is the same
// problem.
//
// Progressive disclosure throughout (the house doctrine): epochs and a progress
// bar by default, steps/pace/legs one click down, probe and loss two.

import { useEffect } from "react";
import { useStore } from "../store";
import { useLoraLab } from "./dock/useLoraLab";
import { FloatingWindow } from "./dock/FloatingWindow";
import { RunHeader } from "./loraLab/RunHeader";
import { TakeSheet } from "./loraLab/TakeSheet";
import { KeptRack } from "./loraLab/KeptRack";
import { trainingBlockers, trainingPreviewLabel } from "../capabilities";

export function LoraLab() {
  const open = useLoraLab((s) => s.open);
  const win = useLoraLab((s) => s.win);
  const close = useLoraLab((s) => s.close);
  const move = useLoraLab((s) => s.move);
  const resize = useLoraLab((s) => s.resize);

  const capabilities = useStore((s) => s.capabilities);
  const loadCapabilities = useStore((s) => s.loadCapabilities);
  const loadLoras = useStore((s) => s.loadLoras);
  const run = useStore((s) => s.labRun);
  const pollRun = useStore((s) => s.pollLabRun);
  const prompt = useStore((s) => s.labPrompt);
  const setPrompt = useStore((s) => s.setLabPrompt);
  const seed = useStore((s) => s.labSeed);
  const setSeed = useStore((s) => s.setLabSeed);
  const sourceClipId = useStore((s) => s.labSourceClipId);
  const setSource = useStore((s) => s.setLabSource);
  const snapshot = useStore((s) => s.snapshot);
  // Corpus size drives the recommended epoch count, and the epoch curve does not
  // transfer between corpora — so the count has to come from the real registry,
  // not a guess.
  const training = useStore((s) => s.snapshot?.training ?? null);
  const startRun = useStore((s) => s.startLabRun);
  const stopRun = useStore((s) => s.stopLabRun);
  const startError = useStore((s) => s.labStartError);

  // Capabilities are fetched LAZILY on open, never at app init: the fetch spawns
  // the generative service, execute_command is synchronous on the UI thread, and
  // doing this eagerly freezes the app on launch. That is a real bug this repo
  // has already shipped once.
  useEffect(() => {
    if (!open) return;
    loadCapabilities();
    loadLoras();
  }, [open, loadCapabilities, loadLoras]);

  // A 1s poll for a 20-60 minute job. Honest and disposable — a dedicated native
  // event rail would be prettier and, at this duration, indistinguishable.
  const active = run?.status === "training" || run?.status === "precompute";
  useEffect(() => {
    if (!open || !active) return;
    const t = setInterval(() => void pollRun(), 1000);
    return () => clearInterval(t);
  }, [open, active, pollRun]);

  if (!open) return null;

  const blockers = trainingBlockers(capabilities);
  const isStub = trainingPreviewLabel(capabilities) !== null;
  const clipCount = training?.sources?.length ?? 0;
  // Only APPROVED sources reach a corpus, so that — not the raw registry count —
  // is what decides whether Train can do anything.
  const eligibleClips = (training?.sources ?? []).filter((x) => x.eligible).length;
  const audioClips = (snapshot?.tracks ?? [])
    .flatMap((t) => t.clips.map((c) => ({ ...c, trackName: t.name })))
    .filter((c) => c.type === "wave");

  return (
    <FloatingWindow win={win} title="LoRA Lab" onMove={move} onResize={resize} onClose={close}>
      <div className="lab" data-testid="lora-lab">
        {/* Unavailability is stated, with the command that fixes it — never a
            Train button that errors on click. A stub backend gets the same
            treatment: it produces a JSON file, not an adapter, and calling that
            "training" would be a lie the UI tells for a full 20 minutes. */}
        {isStub && (
          <div className="lab-block" data-testid="lab-stub">
            <strong>Local training isn't set up on this Mac.</strong>
            <p>The trainer is running its deterministic stub — it writes a placeholder, not a real adapter.</p>
            <code>service/training/setup-trainer.sh</code>
          </div>
        )}
        {!isStub && blockers.length > 0 && (
          <div className="lab-block" data-testid="lab-blockers">
            <strong>Training can't start yet:</strong>
            <ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            <code>service/training/setup-trainer.sh --check</code>
          </div>
        )}

        {/* Train / Stop. The Lab could watch a run and audition its takes but had
            no way to START one — submit_training_job was wired only into the old
            topbar popover, which kept the job id in component state and never
            told the Lab about it. So `labRun` was always null, the run header
            never rendered, and the Lab was a viewer for a run nothing here could
            begin. This is the missing link. */}
        <div className="lab-go">
          {run && (run.status === "training" || run.status === "precompute") ? (
            <button className="btn ghost lab-stop" data-testid="lab-stop"
              title="Stop this run. Checkpoints already published stay auditionable."
              onClick={() => void stopRun()}>Stop training</button>
          ) : (
            <button className="btn primary lab-train" data-testid="lab-train"
              disabled={isStub || blockers.length > 0 || eligibleClips === 0}
              title={isStub ? "The trainer is a stub on this Mac"
                     : blockers.length > 0 ? "Training is blocked — see above"
                     : eligibleClips === 0 ? "Add and approve some sources first (Training tools)"
                     : `Train on ${eligibleClips} approved clip${eligibleClips === 1 ? "" : "s"}`}
              onClick={() => void startRun()}>
              {run ? "Train again" : "Train"}
              {eligibleClips > 0 && <span className="lab-go-n">{eligibleClips} clips</span>}
            </button>
          )}
          {startError && <span className="lab-take-note err" data-testid="lab-start-error">{startError}</span>}
        </div>

        <RunHeader clipCount={clipCount} />

        {/* The audition prompt. Deliberately at the TOP and always visible: every
            take renders through it, so it is the single control that decides what
            question the whole sheet answers. */}
        <div className="lab-ask">
          <input
            className="lab-prompt"
            data-testid="lab-prompt"
            value={prompt}
            placeholder="Prompt to audition with — e.g. “rage trap instrumental, distorted 808, 152 bpm”"
            aria-label="Audition prompt"
            onChange={(e) => setPrompt(e.target.value)}
          />
          <label className="lab-seed" title="Same seed = comparable takes. Change it to hear a different roll of the same adapter.">
            <span>seed</span>
            <input type="number" min={0} value={seed} aria-label="Audition seed"
              onChange={(e) => setSeed(Number(e.target.value))} />
          </label>
        </div>

        {/* Re-imagine source. This is how these adapters are actually used — over
            your own beats — so auditioning purely text-to-audio would grade them
            in a mode nobody works in. Optional, because a bare prompt is the
            faster comparison when you just want to hear the adapter's character. */}
        <label className="lab-source">
          <span>over</span>
          <select
            data-testid="lab-source"
            value={sourceClipId ?? ""}
            aria-label="Re-imagine source clip"
            onChange={(e) => setSource(e.target.value || null)}
          >
            <option value="">nothing — generate from the prompt</option>
            {audioClips.map((c) => (
              <option key={c.id} value={c.id}>{c.trackName} · {c.name}</option>
            ))}
          </select>
        </label>

        <TakeSheet />
        <KeptRack />
      </div>
    </FloatingWindow>
  );
}
