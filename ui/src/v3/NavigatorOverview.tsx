import { trackHue } from "./palette";
import { beatToSeconds, navigatorFraction, type TimelineSnapshot } from "./timelineGeometry";

type OverviewProps = {
  readonly snapshot: TimelineSnapshot;
  readonly totalSec: number;
};

export function NavigatorOverview({ snapshot, totalSec }: OverviewProps) {
  return (
    <div className="ol-nav-map" aria-hidden="true">
      <div className="ol-nav-sections">
        {(snapshot.sections ?? []).map((section) => {
          const left = navigatorFraction(beatToSeconds(snapshot, section.startBeat), totalSec);
          const right = navigatorFraction(beatToSeconds(snapshot, section.endBeat), totalSec);
          return (
            <span
              key={section.id}
              className="ol-nav-section"
              title={section.name}
              style={{
                left: `${left * 100}%`,
                width: `${Math.max(0, right - left) * 100}%`,
                borderColor: section.color ?? "rgba(232, 235, 241, 0.24)",
              }}
            ><span>{section.name}</span></span>
          );
        })}
      </div>
      <div className="ol-nav-tracks">
        {snapshot.tracks.map((track, trackIndex) => {
          const hue = trackHue(trackIndex);
          return (
            <span key={trackIndex} className="ol-nav-track" style={{ color: hue }}>
              {track.clips.filter((clip) => !clip.hidden).map((clip, clipIndex) => (
                <i key={clipIndex} style={{
                  left: `${navigatorFraction(clip.start, totalSec) * 100}%`,
                  width: `${Math.max(0.25, navigatorFraction(clip.length, totalSec) * 100)}%`,
                }} />
              ))}
            </span>
          );
        })}
      </div>
    </div>
  );
}
