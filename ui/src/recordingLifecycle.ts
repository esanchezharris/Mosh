import type { CommandResult } from "./types";

export type RecordingCommandData = {
  applied?: boolean;
  clips?: unknown[];
  reason?: string;
};

export function landedRecordingClipIds(result: CommandResult): string[] | null {
  if (!result.ok || result.command !== "stop_recording") return null;
  const data = result.data as RecordingCommandData | undefined;
  if (data?.applied !== true || !Array.isArray(data.clips) || data.clips.length === 0)
    return null;

  const ids: string[] = [];
  for (const clip of data.clips) {
    if (clip === null || typeof clip !== "object") return null;
    const id = (clip as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim().length === 0) return null;
    ids.push(id);
  }
  return ids;
}
