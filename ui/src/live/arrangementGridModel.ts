import {
  barPosAt,
  barPosToSec,
  gridLines,
  meterAt,
  snapStepBeats,
  type SnapDiv,
  type TempoMap,
} from "../time";

export const ARRANGEMENT_GRID_MAX_LINES = 4096;

export type ArrangementGridLine = {
  readonly sec: number;
  readonly kind: "bar" | "beat" | "subdivision";
};

export function arrangementGridLines(
  map: TempoMap,
  fromSec: number,
  toSec: number,
  division: SnapDiv,
  triplet: boolean,
): readonly ArrangementGridLine[] {
  if (
    map.length === 0
    || !Number.isFinite(fromSec)
    || !Number.isFinite(toSec)
    || toSec < fromSec
    || toSec < 0
  ) return [];

  const startSec = Math.max(0, fromSec);
  const authoritative = gridLines(map, startSec, toSec, ARRANGEMENT_GRID_MAX_LINES);
  const candidates: ArrangementGridLine[] = [
    ...authoritative.bars.map(({ sec }) => ({ sec, kind: "bar" as const })),
    ...authoritative.beats.map((sec) => ({ sec, kind: "beat" as const })),
  ];

  if (division !== "bar" && candidates.length < ARRANGEMENT_GRID_MAX_LINES) {
    const firstBar = Math.max(0, Math.floor(barPosAt(map, startSec)));
    const lastBar = Math.max(firstBar, Math.floor(barPosAt(map, toSec)));
    let estimatedSubdivisions = 0;

    for (let bar = firstBar; bar <= lastBar; bar += 1) {
      const barSec = barPosToSec(map, bar);
      const meter = meterAt(map, barSec);
      const straightStep = snapStepBeats(meter, division) / meter.num;
      const stepBars = triplet ? straightStep * 2 / 3 : straightStep;
      estimatedSubdivisions += Math.ceil(1 / stepBars - 1e-9);
    }

    const available = ARRANGEMENT_GRID_MAX_LINES - candidates.length;
    const stride = Math.max(1, Math.ceil(estimatedSubdivisions / available));
    let subdivisionCount = 0;

    for (let bar = firstBar; bar <= lastBar && subdivisionCount < available; bar += 1) {
      const barSec = barPosToSec(map, bar);
      const meter = meterAt(map, barSec);
      const straightStep = snapStepBeats(meter, division) / meter.num;
      const stepBars = triplet ? straightStep * 2 / 3 : straightStep;
      const count = Math.ceil(1 / stepBars - 1e-9);

      for (let index = 0; index < count && subdivisionCount < available; index += stride) {
        const sec = barPosToSec(map, bar + index * stepBars);
        if (Number.isFinite(sec) && sec >= startSec && sec <= toSec) {
          candidates.push({ sec, kind: "subdivision" });
          subdivisionCount += 1;
        }
      }
    }
  }

  const priority: Readonly<Record<ArrangementGridLine["kind"], number>> = {
    subdivision: 0,
    beat: 1,
    bar: 2,
  };
  candidates.sort((left, right) => left.sec - right.sec || priority[right.kind] - priority[left.kind]);

  const lines: ArrangementGridLine[] = [];
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.sec) || candidate.sec < startSec || candidate.sec > toSec) continue;
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.sec - candidate.sec) <= 1e-9) {
      if (priority[candidate.kind] > priority[previous.kind]) lines[lines.length - 1] = candidate;
      continue;
    }
    if (lines.length === ARRANGEMENT_GRID_MAX_LINES) break;
    lines.push(candidate);
  }
  return lines;
}
