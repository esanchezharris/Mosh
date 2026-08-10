import { barPosToSec, secondsToBBSMap, segAt, tempoMapFrom } from "../time";
import type { Snapshot } from "../types";
import { formatMinutesSeconds, formatSamples, formatTimecode } from "./layout";

export const SPOT_TIME_SCALES = [
  { id: "barsBeats", label: "Bars+Beats" },
  { id: "timecode", label: "Timecode" },
  { id: "minutesSeconds", label: "Minutes:Seconds" },
  { id: "samples", label: "Samples" },
] as const;

export type SpotTimeScale = (typeof SPOT_TIME_SCALES)[number]["id"];

export type SpotTimeParseResult =
  | { readonly ok: true; readonly seconds: number }
  | { readonly ok: false; readonly error: string };

const FORMATTERS = {
  barsBeats: (seconds: number, snapshot: Snapshot) =>
    secondsToBBSMap(tempoMapFrom(snapshot.session), seconds),
  timecode: (seconds: number) => formatTimecode(seconds),
  minutesSeconds: (seconds: number) => formatMinutesSeconds(seconds),
  samples: (seconds: number, snapshot: Snapshot) =>
    formatSamples(seconds, snapshot.session.sampleRate),
} satisfies Record<SpotTimeScale, (seconds: number, snapshot: Snapshot) => string>;

export function formatSpotTime(
  seconds: number,
  scale: SpotTimeScale,
  snapshot: Snapshot,
): string {
  return FORMATTERS[scale](seconds, snapshot);
}

const invalid = (error: string): SpotTimeParseResult => ({ ok: false, error });
const located = (seconds: number): SpotTimeParseResult => Number.isFinite(seconds) && seconds >= 0
  ? { ok: true, seconds }
  : invalid("Location must resolve to a finite, non-negative timeline position.");

function parseBarsBeats(value: string, snapshot: Snapshot): SpotTimeParseResult {
  const match = /^(\d+)[.|](\d+)[.|](\d+)$/.exec(value.trim());
  if (!match) return invalid("Use Bars.Beat.Sixteenth, for example 3.1.1.");
  const bar = Number(match[1]);
  const beat = Number(match[2]);
  const sixteenth = Number(match[3]);
  if (bar < 1 || beat < 1 || sixteenth < 1 || sixteenth > 4)
    return invalid("Bars, beats, and sixteenths start at 1; sixteenths end at 4.");
  const map = tempoMapFrom(snapshot.session);
  const barStart = barPosToSec(map, bar - 1);
  const meter = segAt(map, barStart);
  if (beat > meter.num) return invalid(`Beat must be between 1 and ${meter.num} in this bar.`);
  const barPosition = bar - 1 + (beat - 1) / meter.num + (sixteenth - 1) / (meter.num * 4);
  return located(barPosToSec(map, barPosition));
}

function parseTimecode(value: string): SpotTimeParseResult {
  const match = /^(\d+):([0-5]\d):([0-5]\d):(\d{1,2})$/.exec(value.trim());
  if (!match) return invalid("Use HH:MM:SS:FF timecode.");
  const frames = Number(match[4]);
  if (frames >= 30) return invalid("Frames must be between 00 and 29.");
  const seconds = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + frames / 30;
  return located(seconds);
}

function parseMinutesSeconds(value: string): SpotTimeParseResult {
  const match = /^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return invalid("Use MM:SS.mmm with seconds between 00 and 59.");
  const millis = Number((match[3] ?? "").padEnd(3, "0"));
  return located(Number(match[1]) * 60 + Number(match[2]) + millis / 1_000);
}

function parseSamples(value: string, snapshot: Snapshot): SpotTimeParseResult {
  const digits = value.trim().replace(/,/g, "");
  if (!/^\d+$/.test(digits)) return invalid("Use a non-negative whole sample number.");
  const sampleRate = snapshot.session.sampleRate > 0 ? snapshot.session.sampleRate : 48_000;
  return located(Number(digits) / sampleRate);
}

const PARSERS = {
  barsBeats: parseBarsBeats,
  timecode: (value: string) => parseTimecode(value),
  minutesSeconds: (value: string) => parseMinutesSeconds(value),
  samples: parseSamples,
} satisfies Record<SpotTimeScale, (value: string, snapshot: Snapshot) => SpotTimeParseResult>;

export function parseSpotTime(
  value: string,
  scale: SpotTimeScale,
  snapshot: Snapshot,
): SpotTimeParseResult {
  return PARSERS[scale](value, snapshot);
}
