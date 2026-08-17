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

export type LabRunStatus = "idle" | "precompute" | "training" | "ready" | "error" | "cancelled";

export type LabRun = {
  jobId: string;
  label: string;
  status: LabRunStatus;
  step: number;
  totalSteps: number;
  loss: number | null;
  sPerStep: number | null;
  etaSeconds: number | null;
  leg: number | null;
  legs: number | null;
  error?: string;
};

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

  setLabPrompt: (s: string) => void;
  setLabSource: (clipId: string | null) => void;
  setLabSeed: (n: number) => void;
  setLabCued: (name: string | null) => void;
  dismissLabTake: (name: string) => void;
  restoreLabTakes: () => void;
  /** Render (or replay) one take and start it playing. */
  auditionLabTake: (name: string | null) => Promise<void>;
  stopLabAudition: () => void;
  pollLabRun: () => Promise<void>;
  onLabTakeEvent: (payload: unknown) => void;
  resetLab: () => void;
};

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The key a render is filed under. A null take = the stock model baseline —
 *  the denominator every comparison needs, and the one the owner explicitly
 *  wanted after noting they could not tell how good the base model was. */
export const BASELINE_KEY = "__base__";
export const renderKey = (takeName: string | null) => takeName ?? BASELINE_KEY;

export const createLoraLabSlice: StateCreator<State, [], [], LoraLabSlice> = (set, get) => ({
  labRun: null,
  labTakes: [],
  labRenders: {},
  labCued: null,
  labDismissed: [],
  labPrompt: "",
  labSourceClipId: null,
  labSeed: 42,

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
        step: num(progress.step, run.step),
        totalSteps: num(progress.totalSteps, run.totalSteps),
        loss: typeof progress.loss === "number" ? progress.loss : run.loss,
        sPerStep: typeof progress.sPerStep === "number" ? progress.sPerStep : run.sPerStep,
        etaSeconds: typeof progress.etaSeconds === "number" ? progress.etaSeconds : run.etaSeconds,
        leg: typeof progress.leg === "number" ? progress.leg : run.leg,
        legs: typeof progress.legs === "number" ? progress.legs : run.legs,
        error: str(d.error) || undefined,
      },
    });

    // Takes arrive through the run's progress, since publishing happens as each
    // checkpoint lands. Merge rather than replace: `landedAt` is what orders the
    // sheet newest-first, and re-stamping it on every poll would scramble it.
    const raw = Array.isArray(progress.takes) ? (progress.takes as Record<string, unknown>[]) : [];
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
  }),
});
