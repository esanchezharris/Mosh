import { useEffect, useState } from "react";
import type { Clip, Snapshot, Track } from "../types";
import { ClipView } from "../v2/lanes/ClipView";
import { clipGainAmplitude } from "./clipGain";
import { CLIP_VISUAL_HEADER_PX, TRACK_ROW_HEIGHT } from "./layout";
import { ProToolsClipGain } from "./ProToolsClipGain";
import { ProToolsFadeHandles } from "./ProToolsFadeHandles";
import { proToolsGestureTable } from "./proToolsGestureTable";
import { useProTools } from "./proToolsState";

type ProToolsAudioClipProps = {
  readonly clip: Clip;
  readonly snapshot: Snapshot;
  readonly track: Track;
};

type AudioClipStackStyle = React.CSSProperties & {
  "--pt-clip-gain-scale": number;
};

export function ProToolsAudioClip({ clip, snapshot, track }: ProToolsAudioClipProps) {
  const smartToolEnabled = useProTools((state) => state.smartToolEnabled);
  const activeTool = useProTools((state) => state.activeTool);
  const [previewGain, setPreviewGain] = useState<number | null>(null);
  const gainDb = previewGain ?? clip.gainDb ?? 0;
  const stackStyle: AudioClipStackStyle = {
    "--pt-clip-gain-scale": clipGainAmplitude(gainDb),
  };

  useEffect(() => setPreviewGain(null), [clip.id, clip.gainDb]);

  return (
    <span className="pt-audio-clip-stack" data-testid="pt-audio-clip-stack" style={stackStyle}>
      <ClipView clip={clip} trackType={track.type} snapshot={snapshot}
        clipHeaderPx={(TRACK_ROW_HEIGHT - 30) / 2} clipVisualHeaderPx={CLIP_VISUAL_HEADER_PX}
        gestureTable={() => proToolsGestureTable("audio", smartToolEnabled, activeTool)} />
      <ProToolsFadeHandles clip={clip} />
      <ProToolsClipGain clip={clip} onPreviewGainChange={setPreviewGain} />
    </span>
  );
}
