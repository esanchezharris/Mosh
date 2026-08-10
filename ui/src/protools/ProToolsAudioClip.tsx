import { useCallback, useEffect, useState } from "react";
import type { Clip, ClipGainPoint, Snapshot, Track } from "../types";
import { ClipView } from "../v2/lanes/ClipView";
import { clipGainAmplitude } from "./clipGain";
import { clipGainOffsetAt } from "./clipGainEnvelope";
import { CLIP_VISUAL_HEADER_PX } from "./layout";
import { ProToolsClipGain } from "./ProToolsClipGain";
import { ProToolsFadeHandles } from "./ProToolsFadeHandles";
import { proToolsGestureTable } from "./proToolsGestureTable";
import { useProTools } from "./proToolsState";
import { scaledTrackHeights } from "./trackHeightZoom";

type ProToolsAudioClipProps = {
  readonly clip: Clip;
  readonly snapshot: Snapshot;
  readonly track: Track;
};

const EMPTY_GAIN_POINTS: readonly ClipGainPoint[] = [];

export function ProToolsAudioClip({ clip, snapshot, track }: ProToolsAudioClipProps) {
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const activeTool = useProTools((state) => state.activeTool);
  const audioWaveformZoom = useProTools((state) => state.audioWaveformZoom);
  const trackHeightScale = useProTools((state) => state.trackHeightScale);
  const trackHeight = scaledTrackHeights(trackHeightScale).main;
  const [previewGain, setPreviewGain] = useState<number | null>(null);
  const [previewPoints, setPreviewPoints] = useState<readonly ClipGainPoint[] | null>(null);
  const gainDb = previewGain ?? clip.gainDb ?? 0;
  const gainPoints = previewPoints ?? clip.clipGainPoints ?? EMPTY_GAIN_POINTS;
  const waveAmplitudeAt = useCallback((ratio: number) => clipGainAmplitude(
    gainDb + clipGainOffsetAt(gainPoints, ratio * clip.length),
  ) * audioWaveformZoom, [gainDb, gainPoints, clip.length, audioWaveformZoom]);

  useEffect(() => setPreviewGain(null), [clip.id, clip.gainDb]);
  useEffect(() => setPreviewPoints(null), [clip.id, clip.clipGainPoints]);

  return (
    <span className="pt-audio-clip-stack" data-testid="pt-audio-clip-stack">
      <ClipView clip={clip} trackType={track.type} snapshot={snapshot}
        clipHeaderPx={Math.max(8, (trackHeight - 30) / 2)} clipVisualHeaderPx={CLIP_VISUAL_HEADER_PX}
        gestureTable={() => proToolsGestureTable("audio", smartToolEnabled, activeTool)}
        waveAmplitudeAt={waveAmplitudeAt} />
      <ProToolsFadeHandles clip={clip} />
      <ProToolsClipGain clip={clip} onPreviewGainChange={setPreviewGain}
        onPreviewPointsChange={setPreviewPoints} />
    </span>
  );
}
