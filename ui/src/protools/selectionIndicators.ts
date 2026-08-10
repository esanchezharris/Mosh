import { barPosAt, barPosToSec, segAt, tempoMapFrom } from "../time";
import type { Snapshot } from "../types";
import type { TimeRangeSel } from "../v2/shellState";
import {
  formatSpotTime,
  parseSpotTime,
  type SpotTimeParseResult,
  type SpotTimeScale,
} from "./spotTime";

const invalid = (error: string): SpotTimeParseResult => ({ ok: false, error });

export type SelectionIndicatorDrafts = Readonly<Record<"start" | "end" | "length", string>>;

type SelectionDurationContext = {
  readonly start: number;
  readonly scale: SpotTimeScale;
  readonly snapshot: Snapshot;
};

type SelectionIndicatorDraftOptions = {
  readonly range: TimeRangeSel | null;
  readonly position: number;
  readonly scale: SpotTimeScale;
  readonly snapshot: Snapshot;
};

type FormatSelectionDurationOptions = SelectionDurationContext & {
  readonly seconds: number;
};

type ParseSelectionDurationOptions = SelectionDurationContext & {
  readonly value: string;
};

export function selectionIndicatorDrafts(
  options: SelectionIndicatorDraftOptions,
): SelectionIndicatorDrafts {
  const { range, position, scale, snapshot } = options;
  const start = range?.start ?? position;
  const end = range?.end ?? position;
  return {
    start: formatSpotTime(start, scale, snapshot),
    end: formatSpotTime(end, scale, snapshot),
    length: formatSelectionDuration({
      seconds: Math.max(0, end - start),
      start,
      scale,
      snapshot,
    }),
  };
}

export function formatSelectionDuration(options: FormatSelectionDurationOptions): string {
  const { seconds, start, scale, snapshot } = options;
  const duration = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (scale !== "barsBeats") return formatSpotTime(duration, scale, snapshot);
  const map = tempoMapFrom(snapshot.session);
  const startBar = barPosAt(map, start);
  const endBar = barPosAt(map, start + duration);
  const deltaBars = Math.max(0, endBar - startBar);
  let bars = Math.floor(deltaBars + 1e-9);
  const partialStart = barPosToSec(map, startBar + bars);
  const meter = segAt(map, partialStart);
  let sixteenths = Math.round((deltaBars - bars) * meter.num * 4);
  if (sixteenths >= meter.num * 4) {
    bars += 1;
    sixteenths = 0;
  }
  const beats = Math.floor(sixteenths / 4);
  return `${bars}.${beats}.${sixteenths % 4}`;
}

export function parseSelectionDuration(options: ParseSelectionDurationOptions): SpotTimeParseResult {
  const { value, start, scale, snapshot } = options;
  if (scale !== "barsBeats") {
    const parsed = parseSpotTime(value, scale, snapshot);
    if (!parsed.ok) return parsed;
    return parsed.seconds > 0 ? parsed : invalid("Length must be greater than zero.");
  }

  const match = /^(\d+)[.|](\d+)[.|](\d+)$/.exec(value.trim());
  if (!match) return invalid("Use Bars.Beats.Sixteenths, for example 1.0.0.");
  const bars = Number(match[1]);
  const beats = Number(match[2]);
  const sixteenths = Number(match[3]);
  const map = tempoMapFrom(snapshot.session);
  const startBar = barPosAt(map, start);
  const meter = segAt(map, barPosToSec(map, startBar + bars));
  if (beats >= meter.num)
    return invalid(`Beats must be between 0 and ${meter.num - 1} at the selection start.`);
  if (sixteenths >= 4) return invalid("Sixteenths must be between 0 and 3.");
  const end = barPosToSec(map, startBar + bars + (beats + sixteenths / 4) / meter.num);
  const seconds = end - start;
  return Number.isFinite(seconds) && seconds > 0
    ? { ok: true, seconds }
    : invalid("Length must be greater than zero.");
}
