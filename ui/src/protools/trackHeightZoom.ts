export const TRACK_HEIGHT_LEVELS = [0.75, 1, 1.25, 1.5] as const;

export const BASE_TRACK_ROW_HEIGHT = 92;
export const BASE_PLAYLIST_ROW_HEIGHT = 26;
export const BASE_AUTOMATION_ROW_HEIGHT = 28;

export type ProToolsTrackHeights = {
  readonly main: number;
  readonly playlist: number;
  readonly automation: number;
};

export function clampTrackHeightScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return TRACK_HEIGHT_LEVELS.reduce((nearest, candidate) =>
    Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest);
}

export function nextTrackHeightScale(current: number, direction: -1 | 1): number {
  const normalized = clampTrackHeightScale(current);
  const index = TRACK_HEIGHT_LEVELS.indexOf(normalized as (typeof TRACK_HEIGHT_LEVELS)[number]);
  const nextIndex = Math.min(
    TRACK_HEIGHT_LEVELS.length - 1,
    Math.max(0, index + direction),
  );
  return TRACK_HEIGHT_LEVELS[nextIndex];
}

export function scaledTrackHeights(scale: number): ProToolsTrackHeights {
  const normalized = clampTrackHeightScale(scale);
  return {
    main: Math.round(BASE_TRACK_ROW_HEIGHT * normalized),
    playlist: Math.round(BASE_PLAYLIST_ROW_HEIGHT * normalized),
    automation: Math.round(BASE_AUTOMATION_ROW_HEIGHT * normalized),
  };
}
