import type { Clip, Snapshot } from "../types";
import type { TimeRangeSel } from "../v2/shellState";

export const PROTOOLS_FADE_CURVES = ["linear", "convex", "concave", "sCurve"] as const;
export type ProToolsFadeCurve = (typeof PROTOOLS_FADE_CURVES)[number];

export type ProToolsFadeTarget = {
  readonly trackId: string;
  readonly trackIndex: number;
  readonly clip: Clip;
};

export type ProToolsFadeSelection = {
  readonly snapshot: Snapshot;
  readonly selectedClipIds: ReadonlySet<string>;
  readonly editingClipId: string | null;
  readonly editRange: TimeRangeSel | null;
  readonly editTrackIds: readonly string[];
};

export type ProToolsFadeOptions = {
  readonly fadeIns: boolean;
  readonly fadeOuts: boolean;
  readonly crossfades: boolean;
  readonly edgeLengthMs: number;
  readonly curveIn: ProToolsFadeCurve;
  readonly curveOut: ProToolsFadeCurve;
};

export type ProToolsFadeEdit = {
  readonly clipId: string;
  readonly fadeInSec?: number;
  readonly fadeOutSec?: number;
  readonly curveIn?: ProToolsFadeCurve;
  readonly curveOut?: ProToolsFadeCurve;
};

export type ProToolsCrossfadePair = {
  readonly trackId: string;
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly durationSec: number;
};

export type ProToolsFadePlan = {
  readonly targets: readonly ProToolsFadeTarget[];
  readonly edits: readonly ProToolsFadeEdit[];
  readonly crossfades: readonly ProToolsCrossfadePair[];
  readonly disableAutoCrossfadeIds: readonly string[];
};

const EPSILON = 1e-6;
const FADE_PATHS: Readonly<Record<ProToolsFadeCurve, Readonly<Record<"in" | "out", string>>>> = {
  linear: { in: "M 0 100 L 100 0", out: "M 0 0 L 100 100" },
  convex: {
    in: "M 0 100 C 12 36 48 4 100 0",
    out: "M 0 0 C 52 4 88 36 100 100",
  },
  concave: {
    in: "M 0 100 C 52 96 88 64 100 0",
    out: "M 0 0 C 12 64 48 96 100 100",
  },
  sCurve: {
    in: "M 0 100 C 28 100 72 0 100 0",
    out: "M 0 0 C 28 0 72 100 100 100",
  },
};

export function proToolsFadePath(curve: ProToolsFadeCurve, side: "in" | "out"): string {
  return FADE_PATHS[curve][side];
}

export function proToolsFadeCurveFromType(type: number | undefined): ProToolsFadeCurve {
  if (type === 2) return "convex";
  if (type === 3) return "concave";
  if (type === 4) return "sCurve";
  return "linear";
}

export function proToolsFadeTargets(selection: ProToolsFadeSelection): readonly ProToolsFadeTarget[] {
  const available = selection.snapshot.tracks.flatMap((track) => (
    track.clips
      .filter((clip) => clip.type === "wave" && clip.hidden !== true)
      .map((clip) => ({ trackId: track.id, trackIndex: track.index, clip }))
  )).sort(compareTargets);

  const editRange = selection.editRange;
  if (editRange && selection.editTrackIds.length > 0) {
    const trackIds = new Set(selection.editTrackIds);
    return available.filter((target) => (
      trackIds.has(target.trackId)
      && target.clip.start < editRange.end
      && target.clip.start + target.clip.length > editRange.start
    ));
  }

  const selected = available.filter((target) => selection.selectedClipIds.has(target.clip.id));
  if (selected.length > 0) return selected;
  return available.filter((target) => target.clip.id === selection.editingClipId);
}

export function buildProToolsFadePlan(
  targets: readonly ProToolsFadeTarget[],
  options: ProToolsFadeOptions,
): ProToolsFadePlan {
  const ordered = [...targets].sort(compareTargets);
  const edits = new Map<string, MutableFadeEdit>();
  const crossfades: ProToolsCrossfadePair[] = [];
  const disableAutoCrossfadeIds = new Set<string>();
  const edgeLengthSec = Number.isFinite(options.edgeLengthMs)
    ? Math.max(0, options.edgeLengthMs / 1_000)
    : 0;
  const byTrack = new Map<string, ProToolsFadeTarget[]>();

  for (const target of ordered) {
    const trackTargets = byTrack.get(target.trackId) ?? [];
    trackTargets.push(target);
    byTrack.set(target.trackId, trackTargets);
  }

  for (const [trackId, trackTargets] of byTrack) {
    const first = trackTargets[0];
    const last = trackTargets.at(-1);
    if (options.fadeIns && first && edgeLengthSec > 0) {
      const edit = mutableEdit(edits, first.clip);
      edit.fadeInSec = Math.min(edgeLengthSec, first.clip.length);
      edit.curveIn = options.curveIn;
    }
    if (options.fadeOuts && last && edgeLengthSec > 0) {
      const edit = mutableEdit(edits, last.clip);
      edit.fadeOutSec = Math.min(edgeLengthSec, last.clip.length);
      edit.curveOut = options.curveOut;
    }

    if (!options.crossfades) continue;
    for (let index = 0; index < trackTargets.length - 1; index += 1) {
      const outgoing = trackTargets[index];
      const incoming = trackTargets[index + 1];
      if (!outgoing || !incoming) continue;
      const outgoingEnd = outgoing.clip.start + outgoing.clip.length;
      const incomingEnd = incoming.clip.start + incoming.clip.length;
      const overlapStart = incoming.clip.start;
      const overlapEnd = Math.min(outgoingEnd, incomingEnd);
      const durationSec = overlapEnd - overlapStart;
      const isForwardTransition = incoming.clip.start > outgoing.clip.start + EPSILON
        && incomingEnd > outgoingEnd + EPSILON;
      if (!isForwardTransition || durationSec <= EPSILON) continue;

      const outgoingEdit = mutableEdit(edits, outgoing.clip);
      outgoingEdit.fadeOutSec = durationSec;
      outgoingEdit.curveOut = options.curveOut;
      const incomingEdit = mutableEdit(edits, incoming.clip);
      incomingEdit.fadeInSec = durationSec;
      incomingEdit.curveIn = options.curveIn;
      crossfades.push({
        trackId,
        outgoingClipId: outgoing.clip.id,
        incomingClipId: incoming.clip.id,
        durationSec,
      });
      if (outgoing.clip.autoCrossfade === true) disableAutoCrossfadeIds.add(outgoing.clip.id);
      if (incoming.clip.autoCrossfade === true) disableAutoCrossfadeIds.add(incoming.clip.id);
    }
  }

  return {
    targets: ordered,
    edits: ordered.flatMap((target) => {
      const edit = edits.get(target.clip.id);
      if (!edit) return [];
      normalizeFadeDurations(edit, target.clip.length);
      return [{
        clipId: edit.clipId,
        ...(edit.fadeInSec !== undefined ? { fadeInSec: edit.fadeInSec, curveIn: edit.curveIn } : {}),
        ...(edit.fadeOutSec !== undefined ? { fadeOutSec: edit.fadeOutSec, curveOut: edit.curveOut } : {}),
      }];
    }),
    crossfades,
    disableAutoCrossfadeIds: ordered
      .map((target) => target.clip.id)
      .filter((clipId) => disableAutoCrossfadeIds.has(clipId)),
  };
}

type MutableFadeEdit = {
  clipId: string;
  fadeInSec?: number;
  fadeOutSec?: number;
  curveIn?: ProToolsFadeCurve;
  curveOut?: ProToolsFadeCurve;
};

function compareTargets(left: ProToolsFadeTarget, right: ProToolsFadeTarget): number {
  return left.trackIndex - right.trackIndex
    || left.clip.start - right.clip.start
    || left.clip.id.localeCompare(right.clip.id);
}

function mutableEdit(edits: Map<string, MutableFadeEdit>, clip: Clip): MutableFadeEdit {
  const existing = edits.get(clip.id);
  if (existing) return existing;
  const created: MutableFadeEdit = { clipId: clip.id };
  edits.set(clip.id, created);
  return created;
}

function normalizeFadeDurations(edit: MutableFadeEdit, clipLength: number): void {
  const fadeInSec = edit.fadeInSec ?? 0;
  const fadeOutSec = edit.fadeOutSec ?? 0;
  const total = fadeInSec + fadeOutSec;
  if (total <= clipLength || total <= EPSILON) return;
  const scale = clipLength / total;
  if (edit.fadeInSec !== undefined) edit.fadeInSec *= scale;
  if (edit.fadeOutSec !== undefined) edit.fadeOutSec *= scale;
}
