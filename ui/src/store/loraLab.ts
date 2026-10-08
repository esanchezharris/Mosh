// LoRA Lab state — the run being watched, the takes it produced, and which take
// is cued.
//
// ## Why polling, and why that is the right call
//
// Training runs 20-60 minutes. A dedicated native event rail for its progress
// would be more elegant and would buy nothing a 1s poll doesn't: at that
// duration the difference between "instant" and "within a second" is invisible,
// and the poll is disposable code that cannot desynchronise. The audition side
// is the opposite — it IS event-driven (`lab_take`), because a render finishing
// is the moment the producer is waiting for.
//
// ## Dismissal is UI-local, and deliberately not a delete
//
// Binning a take removes it from the sheet and nothing else. Each one cost ~20
// minutes of compute, and the whole finding behind this feature is that the
// lower-scoring take was sometimes the good one — so the destructive reading of
// "discard" is the wrong one. `forget()` in the service removes a whole run's
// links when the producer explicitly deletes the run.

import type { StateCreator } from "zustand";
import { executeCommand } from "../bridge";
import type { CommandResult } from "../types";
import type { State } from "../store";

/** One auditionable checkpoint. `name` is what the render path resolves. */
export type LabTake = {
  name: string;          // registry name, e.g. "ken-run@600"
  step: number;          // -1 for the end-of-training adapter
  isFinal: boolean;
  landedAt: number;      // client clock — sheet ordering only, never sent anywhere
};

/** A rendered audition of one take (or of an explicit adapter stack). */
export type LabRender = {
  takeId: string;        // the backend's content-addressed id
  status: "rendering" | "ready" | "error";
  progress: number;      // 0..1
  outputWav?: string;
  error?: string;
  peaks?: [number, number][];
};

/** Every status the training service reports for a run that is still going.
 *  service/server.py holds a job "queued" until the training worker takes it,
 *  then "running" through precompute, training and export, and the native relay
 *  (MoshOps cmdTrainingJobStatus) passes that through untouched. WHICH of those
 *  a running job is in is `detail.phase` (LabRun.phase), never the status.
 *  Anything else — "ready", "error", "cancelled", or a name nobody expected —
 *  is a run that has ended.
 *
 *  The one list the poll, Stop and the take sheet all ask. They used to each
 *  test for "training" / "precompute" — phase names no status ever carries — so
 *  on the native app the first poll ended the poll and took Stop away from a
 *  run that had 20-60 minutes left. */
export const LAB_RUN_LIVE_STATUSES = ["queued", "running"] as const;
export type LabRunLiveStatus = (typeof LAB_RUN_LIVE_STATUSES)[number];
export type LabRunStatus = "idle" | LabRunLiveStatus | "ready" | "error" | "cancelled";

export const isLabRunLive = (status: string | null | undefined): status is LabRunLiveStatus =>
  (LAB_RUN_LIVE_STATUSES as readonly string[]).includes(status ?? "");

export type LabRun = {
  jobId: string;
  label: string;
  status: LabRunStatus;
  /** What a running job is doing (`detail.phase`): "precompute" while the local
   *  trainer encodes the corpus, then "training", then the state the trainer
   *  exited in while the service collects the last takes. null for the whole run
   *  on a backend that reports no progress (remote_http), briefly before the
   *  first report, and on a service that predates it. Presentation only —
   *  whether the run is live is `status`. */
  phase: string | null;
  /** While the phase is "precompute": how many of the run's clips have been
   *  encoded so far, of how many. null outside precompute. */
  prepared: number | null;
  preparedOf: number | null;
  step: number;
  totalSteps: number;
  loss: number | null;
  sPerStep: number | null;
  etaSeconds: number | null;
  leg: number | null;
  legs: number | null;
  /** Facts about THIS run, from the service — NOT re-derived from live state.
   *  The corpus it trained on and the batch it used; both are fixed when the
   *  run starts, while the rights registry and the recommended recipe keep
   *  moving. null until the first status carries them (or on an older service). */
  clipCount: number | null;
  batchSize: number | null;
  gradAccum: number | null;
  error?: string;
};

/** One entry in the kept-adapter stack being auditioned together. */
export type LabStackEntry = { name: string; value: number };

export type LoraLabSlice = {
  labRun: LabRun | null;
  labTakes: LabTake[];
  /** Keyed by the take NAME (or a synthetic key for an ad-hoc stack). */
  labRenders: Record<string, LabRender>;
  /** Which take name is currently cued for A/B. UI-local. */
  labCued: string | null;
  /** Take names hidden from the sheet. UI-local; never a delete. */
  labDismissed: string[];
  /** The prompt auditions render with, and the clip they re-imagine (optional). */
  labPrompt: string;
  labSourceClipId: string | null;
  labSeed: number;

  /** Kept adapters currently stacked for audition, in merge ORDER (adapters
   *  merge sequentially, so order is a real parameter, not presentation). */
  labStack: LabStackEntry[];
  /** Per-take message from a refused Keep, shown on the row that caused it. */
  labKeepError: Record<string, string>;
  /** The take name whose Keep is in flight (a copy + validation, ~a second). */
  labKeeping: string | null;

  setLabPrompt: (s: string) => void;
  setLabSource: (clipId: string | null) => void;
  setLabSeed: (n: number) => void;
  setLabCued: (name: string | null) => void;
  dismissLabTake: (name: string) => void;
  restoreLabTakes: () => void;
  /** Render (or replay) one take and start it playing. */
  auditionLabTake: (name: string | null) => Promise<void>;
  /** Keep a take: copy it into the library under `keptName`. Resolves true on
   *  success; a refusal lands in `labKeepError[take]` rather than throwing. */
  promoteLabTake: (take: string, keptName: string) => Promise<boolean>;
  /** Add / set / remove a kept adapter in the audition stack (0 = remove). */
  setLabStackValue: (name: string, value: number) => void;
  /** Audition the whole stack as one take. */
  auditionLabStack: () => Promise<void>;
  /** Build the corpus from approved sources and start a run. */
  startLabRun: (label?: string) => Promise<boolean>;
  /** Stop the run in flight. */
  stopLabRun: () => Promise<void>;
  /** Message from a refused start (no approved sources, blockers, ...). */
  labStartError: string;
  stopLabAudition: () => void;
  pollLabRun: () => Promise<void>;
  onLabTakeEvent: (payload: unknown) => void;
  resetLab: () => void;
};

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");

type LabSet = Parameters<StateCreator<State, [], [], LoraLabSlice>>[0];
type LabGet = Parameters<StateCreator<State, [], [], LoraLabSlice>>[1];

/** The service keeps training jobs in memory only, so after it restarts every
 *  read of a run it had answers "unknown jobId" (native relays that text as is).
 *  Unlike a failed read, that is final: the run is gone. */
const isLostRunError = (error: string | undefined) => /unknown jobId/i.test(error ?? "");

/** Ends the current run here, as failed with `reason`, when nothing is left to
 *  report its end. The poll and Stop then let go of it and Train comes back. A
 *  run that is no longer live is left as it is. */
function endLabRun(set: LabSet, get: LabGet, reason: string) {
  const run = get().labRun;
  if (!run || !isLabRunLive(run.status)) return;
  set({ labRun: { ...run, status: "error", error: reason } } as Partial<State>);
}

/** The key a render is filed under. A null take = the stock model baseline —
 *  the denominator every comparison needs, and the one the owner explicitly
 *  wanted after noting they could not tell how good the base model was. */
export const BASELINE_KEY = "__base__";
export const renderKey = (takeName: string | null) => takeName ?? BASELINE_KEY;

/** The render slot for an ad-hoc STACK of kept adapters. Includes each value and
 *  the order, because both change the sound — a key of names alone would make
 *  two audibly different stacks share one cached render. */
export const stackKey = (stack: LabStackEntry[]) =>
  `__stack__${stack.map((e) => `${e.name}@${e.value}`).join("+")}`;

export const createLoraLabSlice: StateCreator<State, [], [], LoraLabSlice> = (set, get) => ({
  labRun: null,
  labTakes: [],
  labRenders: {},
  labCued: null,
  labDismissed: [],
  labPrompt: "",
  labSourceClipId: null,
  labSeed: 42,
  labStack: [],
  labKeepError: {},
  labKeeping: null,
  labStartError: "",

  setLabPrompt: (s) => set({ labPrompt: s }),
  setLabSource: (clipId) => set({ labSourceClipId: clipId }),
  setLabSeed: (n) => set({ labSeed: Math.max(0, Math.floor(n) || 0) }),
  setLabCued: (name) => set({ labCued: name }),

  dismissLabTake: (name) =>
    set((s) => (s.labDismissed.includes(name) ? s : { labDismissed: [...s.labDismissed, name] } as Partial<State>)),
  restoreLabTakes: () => set({ labDismissed: [] }),

  auditionLabTake: async (name) => {
    const s = get();
    const prompt = s.labPrompt.trim();
    if (!prompt) return;
    const key = renderKey(name);
    const existing = s.labRenders[key];

    // Already rendered: play it straight from disk. Re-submitting would be
    // correct-but-slow (the backend would cache-hit anyway), and A/B comparison
    // only works if switching between takes is immediate.
    if (existing?.status === "ready" && existing.outputWav) {
      set({ labCued: name });
      void executeCommand({ command: "audition_file", args: { path: existing.outputWav } });
      return;
    }

    set((st) => ({
      labCued: name,
      labRenders: { ...st.labRenders, [key]: { takeId: "", status: "rendering", progress: 0 } },
    } as Partial<State>));

    const res = await executeCommand<CommandResult<{ takeId: string; status: string; outputWav?: string }>>({
      command: "render_lora_take",
      args: {
        adapters: name ? [{ name, value: 100 }] : [],
        prompt,
        seed: s.labSeed,
        ...(s.labSourceClipId ? { sourceClipId: s.labSourceClipId } : {}),
      },
    });

    if (!res.ok || !res.data) {
      set((st) => ({
        labRenders: {
          ...st.labRenders,
          [key]: { takeId: "", status: "error", progress: 0, error: res.error || "render failed" },
        },
      } as Partial<State>));
      return;
    }

    const { takeId, status, outputWav } = res.data;
    set((st) => ({
      labRenders: {
        ...st.labRenders,
        [key]: {
          takeId,
          status: status === "ready" ? "ready" : "rendering",
          progress: status === "ready" ? 1 : 0,
          outputWav,
        },
      },
    } as Partial<State>));

    // A cache hit comes back ready in the same call — play it now. A miss plays
    // when its `lab_take` event lands (see onLabTakeEvent).
    if (status === "ready" && outputWav)
      void executeCommand({ command: "audition_file", args: { path: outputWav } });
  },

  startLabRun: async (label) => {
    // Build, then submit. Two commands rather than one because the corpus is a
    // real artifact the producer can inspect, and because building is where the
    // rights gate refuses — a source without proof never reaches a bundle.
    set({ labStartError: "" });
    const built = await executeCommand<CommandResult<{ bundlePath?: string; sourceCount?: number }>>({
      command: "build_training_corpus", args: {},
    });
    if (!built.ok || !built.data?.bundlePath) {
      set({ labStartError: built.error || "no approved sources to train on" });
      return false;
    }

    const runLabel = (label || "").trim() || `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    const res = await executeCommand<CommandResult<{ jobId?: string }>>({
      command: "submit_training_job",
      args: {
        corpusBundle: built.data.bundlePath,
        // No steps/batch here on purpose: omitted, the service applies the
        // MEASURED epoch curve for this corpus size (recipe.py), which is the
        // whole point of having one. The Lab's knobs override it explicitly.
        config: { rank: 16, lr: 0.0001, label: runLabel },
      },
    });
    const jobId = res.data?.jobId ?? "";
    if (!res.ok || !jobId) {
      set({ labStartError: res.error || "could not start training" });
      return false;
    }

    set({
      labRun: {
        // What submit records, natively and in the service, until the first
        // poll says otherwise.
        jobId, label: runLabel, status: "queued", phase: null, prepared: null, preparedOf: null,
        step: 0, totalSteps: 0, loss: null, sPerStep: null, etaSeconds: null,
        leg: null, legs: null,
        // Unknown until the run reports them — deliberately NOT seeded from the
        // live registry or the recommended recipe, which is the bug this whole
        // field exists to fix.
        clipCount: null, batchSize: null, gradAccum: null,
      },
      labTakes: [], labRenders: {}, labCued: null, labDismissed: [],
    } as Partial<State>);
    return true;
  },

  stopLabRun: async () => {
    const run = get().labRun;
    if (!run?.jobId) return;
    const res = await executeCommand<CommandResult>({ command: "cancel_training_job", args: { jobId: run.jobId } });
    // A cancel nothing could deliver (no service, or one that has lost the job)
    // must still end the run here, or Stop does nothing and Train never comes
    // back until the app restarts. It is recorded as failed with the reason,
    // never as "stopped": nothing confirmed that the trainer stopped.
    if (!res.ok) {
      endLabRun(set, get, `could not stop this run: ${res.error || "the training service did not answer"}. The Lab has stopped watching it`);
      return;
    }
    // Don't fake the status — the next poll reports what actually happened.
    // Cancellation has to reach a process group, and claiming "stopped" before
    // it has would be a lie the UI tells for as long as the trainer takes to die.
    void get().pollLabRun();
  },

  promoteLabTake: async (take, keptName) => {
    const name = keptName.trim();
    if (!name) {
      set((st) => ({ labKeepError: { ...st.labKeepError, [take]: "Give it a name first" } } as Partial<State>));
      return false;
    }
    set((st) => ({
      labKeeping: take,
      labKeepError: { ...st.labKeepError, [take]: "" },
    } as Partial<State>));

    const res = await executeCommand<CommandResult<{ name: string }>>({
      command: "promote_lora_checkpoint",
      args: { source: take, name },
    });

    if (!res.ok) {
      // A refusal is the producer's answer ("that name is taken"), not a fault —
      // it belongs on the row they clicked, not in a global error bar where it
      // reads as the app breaking.
      set((st) => ({
        labKeeping: null,
        labKeepError: { ...st.labKeepError, [take]: res.error || "could not keep this take" },
      } as Partial<State>));
      return false;
    }

    set((st) => ({
      labKeeping: null,
      labKeepError: { ...st.labKeepError, [take]: "" },
    } as Partial<State>));
    // Re-read the library so the new adapter appears in the rack immediately;
    // otherwise "Keep" looks like it did nothing until the next reload. Forced:
    // loadLoras keeps its first non-empty answer, so with any adapter already in
    // the library this refresh used to be a no-op.
    get().loadLoras(true);
    return true;
  },

  setLabStackValue: (name, value) => {
    const v = Math.max(0, Math.round(value));
    set((st) => {
      const without = st.labStack.filter((e) => e.name !== name);
      // 0 means removed, not "merged at zero strength" — the registry skips a
      // zero-strength entry anyway, so keeping it would only make the Sigma
      // readout lie about how many adapters are actually in play.
      if (v === 0) return { labStack: without } as Partial<State>;
      const existing = st.labStack.find((e) => e.name === name);
      // Preserve position on a value change; append when newly added, because
      // merge order is sequential and reordering under the producer's hand
      // would silently change the sound.
      return {
        labStack: existing
          ? st.labStack.map((e) => (e.name === name ? { ...e, value: v } : e))
          : [...without, { name, value: v }],
      } as Partial<State>;
    });
  },

  auditionLabStack: async () => {
    const s = get();
    const prompt = s.labPrompt.trim();
    if (!prompt || s.labStack.length === 0) return;
    const key = stackKey(s.labStack);
    const existing = s.labRenders[key];
    if (existing?.status === "ready" && existing.outputWav) {
      set({ labCued: key });
      void executeCommand({ command: "audition_file", args: { path: existing.outputWav } });
      return;
    }
    set((st) => ({
      labCued: key,
      labRenders: { ...st.labRenders, [key]: { takeId: "", status: "rendering", progress: 0 } },
    } as Partial<State>));

    const res = await executeCommand<CommandResult<{ takeId: string; status: string; outputWav?: string }>>({
      command: "render_lora_take",
      args: {
        adapters: s.labStack,
        prompt,
        seed: s.labSeed,
        ...(s.labSourceClipId ? { sourceClipId: s.labSourceClipId } : {}),
      },
    });
    if (!res.ok || !res.data) {
      set((st) => ({
        labRenders: {
          ...st.labRenders,
          [key]: { takeId: "", status: "error", progress: 0, error: res.error || "render failed" },
        },
      } as Partial<State>));
      return;
    }
    const { takeId, status, outputWav } = res.data;
    set((st) => ({
      labRenders: {
        ...st.labRenders,
        [key]: {
          takeId,
          status: status === "ready" ? "ready" : "rendering",
          progress: status === "ready" ? 1 : 0,
          outputWav,
        },
      },
    } as Partial<State>));
    if (status === "ready" && outputWav)
      void executeCommand({ command: "audition_file", args: { path: outputWav } });
  },

  stopLabAudition: () => {
    set({ labCued: null });
    void executeCommand({ command: "stop_audition", args: {} });
  },

  onLabTakeEvent: (payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const takeId = str(p.takeId);
    if (!takeId) return;
    const status = str(p.status);
    const st = get();
    // Events carry the takeId, not the take NAME — find which slot is waiting on
    // it. A take rendered, dismissed, then re-requested keeps the same id (it is
    // content-addressed), so matching on id is what keeps the sheet consistent.
    const entry = Object.entries(st.labRenders).find(([, r]) => r.takeId === takeId);
    // ...or the slot that submitted and has not yet learned its id.
    const key = entry?.[0] ?? Object.entries(st.labRenders)
      .find(([, r]) => !r.takeId && r.status === "rendering")?.[0];
    if (!key) return;

    const next: LabRender = {
      ...(st.labRenders[key] ?? { takeId, status: "rendering", progress: 0 }),
      takeId,
      status: status === "ready" ? "ready" : status === "error" ? "error" : "rendering",
      progress: status === "ready" ? 1 : num(p.progress, st.labRenders[key]?.progress ?? 0),
      outputWav: str(p.outputWav) || st.labRenders[key]?.outputWav,
      error: str(p.error) || undefined,
    };
    set((s) => ({ labRenders: { ...s.labRenders, [key]: next } } as Partial<State>));

    // Play it the moment it is ready, but ONLY if it is still the cued take.
    // Without that check, a take the producer moved on from starts playing over
    // whatever they are listening to now — the render takes long enough that
    // this is the normal case, not an edge one.
    const cuedKey = renderKey(get().labCued);
    if (next.status === "ready" && next.outputWav && cuedKey === key)
      void executeCommand({ command: "audition_file", args: { path: next.outputWav } });
  },

  pollLabRun: async () => {
    const run = get().labRun;
    if (!run?.jobId) return;
    const res = await executeCommand<CommandResult<Record<string, unknown>>>({
      command: "training_job_status",
      args: { jobId: run.jobId },
    });
    if (!res.ok && isLostRunError(res.error)) {
      endLabRun(set, get, `the training service no longer has this run (${res.error}); it restarted or stopped while training`);
      return;
    }
    // Any other failed read may be a hiccup, and the run may well still be going:
    // keep the status and ask again on the next poll. Stop is the way out if the
    // service never answers again.
    if (!res.ok || !res.data) return;
    const d = res.data;
    // `progress` is a coarse 0..1 FLOAT for a generic bar; the per-step numbers
    // live in `detail`. Reading step/loss/eta off `progress` yields undefined for
    // every field and a header frozen at zero for the whole run, with training
    // working perfectly the entire time — which reads as a dead UI rather than a
    // wrong field.
    const progress = (d.detail ?? {}) as Record<string, unknown>;
    const status = str(d.status) || run.status;

    set({
      labRun: {
        ...run,
        status: (status as LabRunStatus) || run.status,
        phase: str(progress.phase) || null,
        prepared: typeof progress.precomputed === "number" ? progress.precomputed : null,
        preparedOf: typeof progress.clips === "number" ? progress.clips : null,
        step: num(progress.step, run.step),
        totalSteps: num(progress.totalSteps, run.totalSteps),
        loss: typeof progress.loss === "number" ? progress.loss : run.loss,
        sPerStep: typeof progress.sPerStep === "number" ? progress.sPerStep : run.sPerStep,
        etaSeconds: typeof progress.etaSeconds === "number" ? progress.etaSeconds : run.etaSeconds,
        leg: typeof progress.leg === "number" ? progress.leg : run.leg,
        legs: typeof progress.legs === "number" ? progress.legs : run.legs,
        // Sticky: once the run has told us what it is training on, keep it. A
        // later poll that omits the field (or a service that predates it) must
        // not blank a number the header is already showing.
        clipCount: typeof progress.clipCount === "number" ? progress.clipCount : run.clipCount,
        batchSize: typeof progress.batchSize === "number" ? progress.batchSize : run.batchSize,
        gradAccum: typeof progress.gradAccum === "number" ? progress.gradAccum : run.gradAccum,
        error: str(d.error) || undefined,
      },
    });

    // Takes arrive through the run's progress, since publishing happens as each
    // checkpoint lands. Merge rather than replace: `landedAt` is what orders the
    // sheet newest-first, and re-stamping it on every poll would scramble it.
    // The final adapter (`@final`) is published only once the trainer has exited,
    // so it is in the finished run's `result.takes` and never in its progress:
    // read both, or the sheet never offers the take the run was for.
    const result = (d.result ?? {}) as Record<string, unknown>;
    const raw = [progress.takes, result.takes]
      .flatMap((list) => (Array.isArray(list) ? (list as Record<string, unknown>[]) : []));
    if (raw.length) {
      const known = new Map(get().labTakes.map((t) => [t.name, t]));
      const now = Date.now();
      let changed = false;
      for (const t of raw) {
        const name = str(t.name);
        if (!name || known.has(name)) continue;
        known.set(name, {
          name,
          step: num(t.step, -1),
          isFinal: t.isFinal === true,
          landedAt: now,
        });
        changed = true;
      }
      if (changed) set({ labTakes: [...known.values()] });
    }
  },

  resetLab: () => set({
    labRun: null, labTakes: [], labRenders: {}, labCued: null, labDismissed: [],
    labStack: [], labKeepError: {}, labKeeping: null, labStartError: "",
  }),
});
