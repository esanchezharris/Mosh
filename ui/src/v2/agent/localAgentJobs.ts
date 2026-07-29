import type { Clip, CommandResult, Snapshot } from "../../types";
import { sectionTargetFor } from "../timeline/sectionRender";

export type LocalAgentWorker = "Mosh" | "Drummer" | "Arranger" | "Generator";

export type LocalAgentJobView = {
  id: string;
  worker: LocalAgentWorker;
  label: string;
  clipId?: string;
  progress: number | null;
  status: "queued" | "running";
};

type Exec = (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;

const DRUMMER_PATTERN =
  "kick: X...x...X...x...; snare: ....X.......X...; hat: x.x.x.x.x.x.x.x.";

function allClips(snapshot: Snapshot | null): Clip[] {
  return snapshot?.tracks.flatMap((track) => track.clips) ?? [];
}

function isScopedRegion(clip: Clip): boolean {
  const { regionStart, regionEnd } = clip.renderLayer ?? {};
  if (regionStart === undefined || regionEnd === undefined) return false;
  const clipEnd = clip.start + clip.length;
  return regionStart > clip.start + 1e-3 || regionEnd < clipEnd - 1e-3;
}

export function selectedClip(snapshot: Snapshot | null, clipId: string | null): Clip | null {
  if (!clipId) return null;
  return allClips(snapshot).find((clip) => clip.id === clipId) ?? null;
}

export function deriveLocalAgentJobs(
  snapshot: Snapshot | null,
  renderProgress: Record<string, number>,
  agentBusy: boolean,
): LocalAgentJobView[] {
  const jobs: LocalAgentJobView[] = [];

  for (const track of snapshot?.tracks ?? []) {
    for (const clip of track.clips) {
      const layer = clip.renderLayer;
      if (!layer || (layer.status !== "queued" && layer.status !== "rendering")) continue;
      const arranged = isScopedRegion(clip);
      jobs.push({
        id: `render:${clip.id}`,
        worker: arranged ? "Arranger" : "Generator",
        label: arranged ? `Reworking ${clip.name}` : `Re-imagining ${clip.name}`,
        clipId: clip.id,
        progress: renderProgress[clip.id] ?? (layer.status === "queued" ? 0 : null),
        status: layer.status === "queued" ? "queued" : "running",
      });
    }
  }

  if (agentBusy && jobs.length === 0) {
    jobs.push({
      id: "agent:orchestrator",
      worker: "Mosh",
      label: "Planning the next moves",
      progress: null,
      status: "running",
    });
  }

  return jobs;
}

export async function runDrummer(
  exec: Exec,
  snapshot: Snapshot | null,
  selectedTrackId: string | null,
): Promise<void> {
  const selectedTrack = snapshot?.tracks.find((track) => track.id === selectedTrackId);
  const drumTrack = selectedTrack?.type === "drum"
    ? selectedTrack
    : snapshot?.tracks.find((track) => track.type === "drum");
  const drumClip = drumTrack?.clips.find((clip) => clip.type === "midi");

  await exec("add_drum_pattern", {
    pattern: DRUMMER_PATTERN,
    stepsPerBar: 16,
    bars: 2,
    ...(drumClip ? { clipId: drumClip.id } : drumTrack ? { trackId: drumTrack.id } : {}),
  });
}

export async function runArranger(
  exec: Exec,
  snapshot: Snapshot | null,
  selectedTrackId: string | null,
  range: { start: number; end: number } | null,
): Promise<boolean> {
  const target = sectionTargetFor(snapshot?.tracks ?? [], selectedTrackId, range);
  if (!target) return false;

  const create = await exec("create_render_layer", target);
  if (!create.ok) return true;
  await exec("set_render_param", {
    clipId: target.clipId,
    prompt: "a tasteful variation that keeps the groove and musical identity",
  });
  await exec("render_layer", { clipId: target.clipId });
  return true;
}

export async function runGenerator(
  exec: Exec,
  snapshot: Snapshot | null,
  selectedClipId: string | null,
  stableAudioAvailable: boolean,
): Promise<boolean> {
  const clip = selectedClip(snapshot, selectedClipId);
  if (!clip) return false;

  if (!clip.renderLayer) {
    const create = await exec("create_render_layer", {
      clipId: clip.id,
      adapter: stableAudioAvailable ? "stable_audio3" : "fake",
      mode: "reimagine",
      ...(stableAudioAvailable ? { modelVariant: "sa3-medium" } : {}),
    });
    if (!create.ok) return true;
  }
  await exec("render_layer", { clipId: clip.id });
  return true;
}
